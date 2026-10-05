#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --in-session ]]; then
    shift
    gtk4-broadwayd -u "$XDG_RUNTIME_DIR/broadway-http.socket" :7 > "$XDG_RUNTIME_DIR/broadway.log" 2>&1 &
    task_broadway_pid=$!
    trap 'kill "$task_broadway_pid" 2>/dev/null || true' EXIT
    for ((attempt = 0; attempt < 60; attempt++)); do
        if [[ -S "$XDG_RUNTIME_DIR/broadway7.socket" ]]; then
            break
        fi
        if ! kill -0 "$task_broadway_pid" 2>/dev/null; then
            cat "$XDG_RUNTIME_DIR/broadway.log"
            exit 1
        fi
        sleep 0.1
    done
    gjs -m "$1/tests/preferences.test.js"
    exit
fi

task_test_dir=$(mktemp -d /tmp/touchpad-preferences.XXXXXX)
trap 'rm -rf "$task_test_dir"' EXIT
mkdir -p "$task_test_dir/runtime" "$task_test_dir/config" "$task_test_dir/cache" "$task_test_dir/data"
chmod 700 "$task_test_dir/runtime"
export XDG_RUNTIME_DIR="$task_test_dir/runtime"
export XDG_CONFIG_HOME="$task_test_dir/config"
export XDG_CACHE_HOME="$task_test_dir/cache"
export XDG_DATA_HOME="$task_test_dir/data"
export GDK_BACKEND=broadway BROADWAY_DISPLAY=:7 GSETTINGS_BACKEND=memory GTK_A11Y=none
export GDK_DEBUG=no-portals ADW_DISABLE_PORTAL=1 GIO_USE_VFS=local
unset DISPLAY WAYLAND_DISPLAY
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_extension_dir="$XDG_DATA_HOME/gnome-shell/extensions/touchpad-scroll-speed@danielmzh.github.io"
mkdir -p "$(dirname -- "$task_extension_dir")"
cp -a "$project_dir/extension" "$task_extension_dir"
glib-compile-schemas --strict "$task_extension_dir/schemas"
for task_ui_language in en es; do
    if [[ $task_ui_language == es ]]; then
        task_ui_locale=es_CL.UTF-8
    else
        task_ui_locale=en_US.UTF-8
    fi
    mkdir -m 700 "$task_test_dir/runtime-$task_ui_language"
    XDG_RUNTIME_DIR="$task_test_dir/runtime-$task_ui_language" \
        LC_ALL="$task_ui_locale" LANGUAGE="$task_ui_language" \
        EXPECTED_UI_LANGUAGE="$task_ui_language" \
        TEST_EXTENSION_DIR="$task_extension_dir" \
        dbus-run-session -- bash "${BASH_SOURCE[0]}" --in-session "$project_dir"
done
