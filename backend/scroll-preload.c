/* SPDX-License-Identifier: GPL-2.0-or-later */
#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libinput.h>
#include <limits.h>
#include <locale.h>
#include <math.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* Only libinput finger scrolling is scaled. Mouse motion and wheel scrolling
 * keep their original libinput values. A short lease makes the hook fall back
 * to normal speed when the extension stops running. */
#define CONFIG_NAME "touchpad-scroll-speed.factor"
#define CACHE_MICROSECONDS UINT64_C(50000)
#define MAX_LEASE_MICROSECONDS UINT64_C(10000000)

typedef double (*ScrollValueFn)(struct libinput_event_pointer *,
                                enum libinput_pointer_axis);
typedef struct libinput_event *(*BaseEventFn)(struct libinput_event_pointer *);
typedef enum libinput_event_type (*EventTypeFn)(struct libinput_event *);

static ScrollValueFn original_scroll_value;
static BaseEventFn original_base_event;
static EventTypeFn original_event_type;
static pthread_once_t initialize_once = PTHREAD_ONCE_INIT;
static pthread_mutex_t factor_lock = PTHREAD_MUTEX_INITIALIZER;
static locale_t number_locale;
static bool active;
static char config_path[PATH_MAX];
static uint64_t last_read;
static uint64_t cached_expiry;
static double cached_factor = 1.0;

static uint64_t
monotonic_microseconds(void)
{
    struct timespec now;

    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0)
        return 0;

    return (uint64_t) now.tv_sec * UINT64_C(1000000) +
           (uint64_t) now.tv_nsec / UINT64_C(1000);
}

static bool
process_is_gnome_shell(void)
{
    char process_name[32];
    ssize_t length;
    int fd = open("/proc/self/comm", O_RDONLY | O_CLOEXEC);

    if (fd < 0)
        return false;
    do {
        length = read(fd, process_name, sizeof(process_name) - 1);
    } while (length < 0 && errno == EINTR);
    close(fd);
    if (length <= 0)
        return false;
    if (process_name[length - 1] == '\n')
        length--;
    process_name[length] = '\0';
    return strcmp(process_name, "gnome-shell") == 0;
}

static void
initialize(void)
{
    const char *runtime_dir;

    original_scroll_value = (ScrollValueFn)
        dlsym(RTLD_NEXT, "libinput_event_pointer_get_scroll_value");
    original_base_event = (BaseEventFn)
        dlsym(RTLD_NEXT, "libinput_event_pointer_get_base_event");
    original_event_type = (EventTypeFn)
        dlsym(RTLD_NEXT, "libinput_event_get_type");

    /* Mutter first calls the getter in its input thread. PR_GET_NAME would
     * identify that thread (mutter-input), so use the main process's comm. */
    if (!process_is_gnome_shell() ||
        !original_scroll_value || !original_base_event || !original_event_type)
        return;

    runtime_dir = getenv("XDG_RUNTIME_DIR");
    if (!runtime_dir || runtime_dir[0] != '/' ||
        snprintf(config_path, sizeof(config_path), "%s/%s", runtime_dir,
                 CONFIG_NAME) >= (int) sizeof(config_path))
        return;

    number_locale = newlocale(LC_NUMERIC_MASK, "C", (locale_t) 0);
    active = number_locale != (locale_t) 0;
}

static void
read_factor(uint64_t now)
{
    char contents[128];
    char *end;
    char *expiry_start;
    struct stat info;
    size_t length = 0;
    double factor;
    unsigned long long expiry;
    int fd;

    cached_factor = 1.0;
    cached_expiry = 0;
    last_read = now;

    fd = open(config_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0)
        return;

    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) ||
        info.st_uid != getuid() || info.st_size <= 0 ||
        info.st_size >= (off_t) sizeof(contents)) {
        close(fd);
        return;
    }

    while (length < sizeof(contents) - 1) {
        ssize_t received = read(fd, contents + length,
                                sizeof(contents) - 1 - length);
        if (received < 0 && errno == EINTR)
            continue;
        if (received < 0) {
            close(fd);
            return;
        }
        if (received == 0)
            break;
        length += (size_t) received;
    }
    close(fd);

    /* Reject embedded NULs and anything outside the ASCII lease format. */
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char) contents[i];
        if (c == 0 || c > 127)
            return;
    }
    contents[length] = '\0';
    errno = 0;
    factor = strtod_l(contents, &end, number_locale);
    if (errno || end == contents || !isfinite(factor) ||
        factor < 0.05 || factor > 1.5 || (*end != ' ' && *end != '\t'))
        return;

    while (*end == ' ' || *end == '\t')
        end++;
    expiry_start = end;
    if (*expiry_start < '0' || *expiry_start > '9')
        return;
    errno = 0;
    expiry = strtoull(expiry_start, &end, 10);
    if (errno || end == expiry_start)
        return;
    while (*end == ' ' || *end == '\t' || *end == '\r' || *end == '\n')
        end++;
    if (*end != '\0' || expiry <= now || expiry - now > MAX_LEASE_MICROSECONDS)
        return;

    cached_factor = factor;
    cached_expiry = (uint64_t) expiry;
}

static double
current_factor(void)
{
    uint64_t now = monotonic_microseconds();
    double factor;

    if (!now)
        return 1.0;

    pthread_mutex_lock(&factor_lock);
    if (!last_read || now < last_read || now - last_read >= CACHE_MICROSECONDS)
        read_factor(now);
    factor = cached_expiry > now ? cached_factor : 1.0;
    pthread_mutex_unlock(&factor_lock);
    return factor;
}

double
libinput_event_pointer_get_scroll_value(struct libinput_event_pointer *event,
                                       enum libinput_pointer_axis axis)
{
    double value;
    struct libinput_event *base;

    pthread_once(&initialize_once, initialize);
    if (!original_scroll_value)
        return 0.0;

    value = original_scroll_value(event, axis);
    if (!active)
        return value;

    base = original_base_event(event);
    if (!base || original_event_type(base) != LIBINPUT_EVENT_POINTER_SCROLL_FINGER)
        return value;

    return value * current_factor();
}

static bool
is_own_preload(const char *entry, const char *library_path,
               const char *canonical_library_path)
{
    char canonical_entry[PATH_MAX];
    const char *basename;

    if (strcmp(entry, library_path) == 0)
        return true;
    if (canonical_library_path && realpath(entry, canonical_entry) &&
        strcmp(canonical_entry, canonical_library_path) == 0)
        return true;

    /* A preload resolved via LD_LIBRARY_PATH may have been specified by its
     * filename alone, while dladdr reports its resolved filesystem path. */
    basename = strrchr(library_path, '/');
    return !strchr(entry, '/') && basename && strcmp(entry, basename + 1) == 0;
}

__attribute__((constructor)) static void
prevent_child_preload(void)
{
    Dl_info library_info;
    const char *preload = getenv("LD_PRELOAD");
    char canonical_library_path[PATH_MAX];
    char *canonical = NULL;
    char *entries;
    char *remaining;
    char *saveptr = NULL;
    char *entry;
    size_t used = 0;
    bool removed = false;

    if (!preload || !*preload ||
        !dladdr((void *) prevent_child_preload, &library_info) ||
        !library_info.dli_fname)
        return;
    if (realpath(library_info.dli_fname, canonical_library_path))
        canonical = canonical_library_path;

    entries = strdup(preload);
    remaining = malloc(strlen(preload) + 1);
    if (!entries || !remaining) {
        free(entries);
        free(remaining);
        return;
    }

    for (entry = strtok_r(entries, ": \t\n\r\v\f", &saveptr); entry;
         entry = strtok_r(NULL, ": \t\n\r\v\f", &saveptr)) {
        size_t length;

        if (is_own_preload(entry, library_info.dli_fname, canonical)) {
            removed = true;
            continue;
        }
        length = strlen(entry);
        if (used)
            remaining[used++] = ':';
        memcpy(remaining + used, entry, length);
        used += length;
    }
    remaining[used] = '\0';
    if (removed) {
        if (used)
            setenv("LD_PRELOAD", remaining, 1);
        else
            unsetenv("LD_PRELOAD");
    }
    free(entries);
    free(remaining);
}
