#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$project_dir/dist"
read -r -a libinput_flags <<< "$(pkg-config --cflags libinput)"
"${CC:-cc}" -std=gnu11 -O2 -Wall -Wextra -Werror -fPIC -shared \
    "${libinput_flags[@]}" "$project_dir/backend/scroll-preload.c" \
    -o "$project_dir/dist/libtouchpad-scroll.so" -ldl -pthread
printf 'Library created: %s\n' "$project_dir/dist/libtouchpad-scroll.so"
