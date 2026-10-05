/* SPDX-License-Identifier: GPL-2.0-or-later */
#define _GNU_SOURCE
#include "backend-mock.h"

#include <assert.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static char config_path[4096];
static struct libinput_event_pointer finger = {
    .base.type = LIBINPUT_EVENT_POINTER_SCROLL_FINGER,
    .horizontal = -8.0,
    .vertical = 12.0,
};

static uint64_t
now_microseconds(void)
{
    struct timespec now;
    assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
    return (uint64_t) now.tv_sec * UINT64_C(1000000) +
           (uint64_t) now.tv_nsec / UINT64_C(1000);
}

static void
write_raw(const char *contents)
{
    FILE *file = fopen(config_path, "w");
    assert(file);
    assert(fputs(contents, file) >= 0);
    assert(fclose(file) == 0);
    /* The hook intentionally polls changes at most every 50 ms. */
    usleep(60000);
}

static void
write_lease(double factor, uint64_t expiry)
{
    char contents[128];
    snprintf(contents, sizeof(contents), "%.17g %llu\n", factor,
             (unsigned long long) expiry);
    write_raw(contents);
}

static void
expect_value(enum libinput_pointer_axis axis, double expected)
{
    double actual = libinput_event_pointer_get_scroll_value(&finger, axis);
    if (fabs(actual - expected) > 1e-10) {
        fprintf(stderr, "Expected %.17g, received %.17g\n", expected, actual);
        exit(1);
    }
}

static void
expect_factor(double factor)
{
    expect_value(LIBINPUT_POINTER_AXIS_SCROLL_VERTICAL, 12.0 * factor);
    expect_value(LIBINPUT_POINTER_AXIS_SCROLL_HORIZONTAL, -8.0 * factor);
}

static void *
query_thread(void *unused)
{
    (void) unused;
    for (int i = 0; i < 1000; i++)
        expect_factor(1.25);
    return NULL;
}

static void *
first_input_thread_query(void *expected_factor)
{
    assert(prctl(PR_SET_NAME, "mutter-input") == 0);
    expect_factor(*(double *) expected_factor);
    return NULL;
}

int
main(int argc, char **argv)
{
    const char *preload;
    const char *expected_preload;
    const char *runtime = getenv("XDG_RUNTIME_DIR");
    bool other_app;

    assert(argc == 3);
    other_app = strcmp(argv[1], "other-app") == 0;
    assert(prctl(PR_SET_NAME, other_app ? "test-app" : "gnome-shell") == 0);
    assert(runtime);
    assert(snprintf(config_path, sizeof(config_path), "%s/%s", runtime,
                    "touchpad-scroll-speed.factor") < (int) sizeof(config_path));

    expected_preload = argv[2];
    preload = getenv("LD_PRELOAD");
    assert(strcmp(preload ? preload : "", expected_preload) == 0);

    if (strcmp(argv[1], "child") == 0) {
        /* The exec'd child has the unrelated preload and no scroll hook. */
        expect_factor(1.0);
        puts("Child does not inherit scroll preload: OK");
        return 0;
    }

    write_lease(0.5, now_microseconds() + UINT64_C(6000000));
    double expected_first_factor = other_app ? 1.0 : 0.5;
    pthread_t input_thread;
    assert(pthread_create(&input_thread, NULL, first_input_thread_query,
                          &expected_first_factor) == 0);
    assert(pthread_join(input_thread, NULL) == 0);
    if (other_app) {
        expect_factor(1.0);
        puts("Other application remains unchanged: OK");
        return 0;
    }
    expect_factor(0.5);

    finger.base.type = LIBINPUT_EVENT_POINTER_SCROLL_WHEEL;
    expect_factor(1.0);
    finger.base.type = LIBINPUT_EVENT_POINTER_SCROLL_CONTINUOUS;
    expect_factor(1.0);
    finger.base.type = LIBINPUT_EVENT_POINTER_MOTION;
    expect_factor(1.0);
    finger.base.type = LIBINPUT_EVENT_POINTER_SCROLL_FINGER;

    finger.vertical = -0.0;
    double zero = libinput_event_pointer_get_scroll_value(
        &finger, LIBINPUT_POINTER_AXIS_SCROLL_VERTICAL);
    assert(zero == 0.0 && signbit(zero));
    finger.vertical = 12.0;

    write_lease(1.5, now_microseconds() + UINT64_C(6000000));
    expect_factor(1.5);
    write_lease(0.05, now_microseconds() + UINT64_C(6000000));
    expect_factor(0.05);
    write_lease(1.25, now_microseconds() + UINT64_C(6000000));
    expect_factor(1.25);

    pthread_t threads[4];
    for (size_t i = 0; i < 4; i++)
        assert(pthread_create(&threads[i], NULL, query_thread, NULL) == 0);
    for (size_t i = 0; i < 4; i++)
        assert(pthread_join(threads[i], NULL) == 0);

    /* Own entry is removed but any unrelated preload survives exec. */
    pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
        execl(argv[0], argv[0], "child", expected_preload, (char *) NULL);
        _exit(127);
    }
    int status;
    assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);

    assert(unlink(config_path) == 0);
    usleep(60000);
    expect_factor(1.0);
    write_lease(1.25, now_microseconds() - 1);
    expect_factor(1.0);
    write_lease(1.25, now_microseconds() + UINT64_C(11000000));
    expect_factor(1.0);

    const char *invalid[] = {
        "garbage\n", "1.25\n", "1.25 -1\n", "1.25 18446744073709551616\n",
        "0.049 1\n", "1.501 1\n", "nan 1\n", "inf 1\n", "1.25 1 trailing\n",
        "0,5 1\n", "1.25 0\n", "1.25 1 2\n",
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        write_raw(invalid[i]);
        expect_factor(1.0);
    }

    /* Keep the expiry valid to prove the factor itself is validated. */
    const char *bad_factors[] = {"0.049", "1.501", "2", "-1", "nan", "inf", "0,5"};
    for (size_t i = 0; i < sizeof(bad_factors) / sizeof(bad_factors[0]); i++) {
        char contents[128];
        snprintf(contents, sizeof(contents), "%s %llu\n", bad_factors[i],
                 (unsigned long long) (now_microseconds() + UINT64_C(6000000)));
        write_raw(contents);
        expect_factor(1.0);
    }

    char trailing[128];
    snprintf(trailing, sizeof(trailing), "1.25 %llu unexpected\n",
             (unsigned long long) (now_microseconds() + UINT64_C(6000000)));
    write_raw(trailing);
    expect_factor(1.0);

    /* An expired lease is rejected even while its previous value is cached. */
    write_lease(1.25, now_microseconds() + UINT64_C(100000));
    expect_factor(1.25);
    usleep(45000);
    expect_factor(1.0);

    /* A symlink cannot substitute a different file for the lease. */
    assert(unlink(config_path) == 0);
    assert(symlink("/dev/zero", config_path) == 0);
    usleep(60000);
    expect_factor(1.0);
    assert(unlink(config_path) == 0);

    puts("Finger scaling, live factor, axes, other input, leases and preload: OK");
    return 0;
}
