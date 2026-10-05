#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v gnome-extensions >/dev/null || {
    echo 'Missing gnome-extensions (the gnome-shell package on Debian).' >&2
    exit 1
}
mkdir -p "$project_dir/dist"
python3 "$project_dir/build-translations.py"
glib-compile-schemas --strict "$project_dir/extension/schemas"
gnome-extensions pack "$project_dir/extension" \
    --force --out-dir="$project_dir/dist" \
    --extra-source=speed.js --extra-source=LICENSE --extra-source=locale \
    --schema=schemas/org.gnome.shell.extensions.touchpad-scroll-speed.gschema.xml
uuid=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["uuid"])' "$project_dir/extension/metadata.json")
echo "Package created: $project_dir/dist/$uuid.shell-extension.zip"
