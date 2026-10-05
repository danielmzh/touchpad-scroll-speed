#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT

bash "$project_dir/build-backend.sh"
read -r -a libinput_flags <<< "$(pkg-config --cflags libinput)"
compiler_flags=(-std=gnu11 -Wall -Wextra -Werror "${libinput_flags[@]}")
"${CC:-cc}" "${compiler_flags[@]}" -fPIC -shared \
    "$project_dir/tests/backend-mock.c" -o "$test_dir/libinput-mock.so"
"${CC:-cc}" "${compiler_flags[@]}" "$project_dir/tests/backend-driver.c" \
    -L "$test_dir" -linput-mock -Wl,-rpath,"$test_dir" \
    -pthread -lm -o "$test_dir/backend-driver"
printf 'void untouched_preload(void) {}\n' > "$test_dir/untouched.c"
"${CC:-cc}" -fPIC -shared "$test_dir/untouched.c" -o "$test_dir/untouched.so"

preload="$project_dir/dist/libtouchpad-scroll.so"
env XDG_RUNTIME_DIR="$test_dir" LD_PRELOAD="$preload" \
    "$test_dir/backend-driver" gnome-shell ''
env XDG_RUNTIME_DIR="$test_dir" LD_PRELOAD="$test_dir/untouched.so:$preload" \
    "$test_dir/backend-driver" gnome-shell "$test_dir/untouched.so"
env XDG_RUNTIME_DIR="$test_dir" LD_PRELOAD="$preload $test_dir/untouched.so" \
    "$test_dir/backend-driver" other-app "$test_dir/untouched.so"
