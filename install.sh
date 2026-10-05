#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
uuid=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["uuid"])' "$project_dir/extension/metadata.json")
legacy_uuid='sensibilidad-touchpad@local'

if (( EUID == 0 )); then
    echo 'Run this installer as your desktop user, without sudo.' >&2
    exit 1
fi
shell_version="$(gnome-shell --version)"
if [[ "$shell_version" != 'GNOME Shell 48.'* && "$shell_version" != 'GNOME Shell 48' ]]; then
    echo "This extension requires GNOME 48. Detected: $shell_version" >&2
    exit 1
fi
if [[ ${XDG_SESSION_TYPE:-wayland} != wayland ]]; then
    echo 'Scroll adjustment requires a GNOME session on Wayland.' >&2
    exit 1
fi

bash "$project_dir/build-backend.sh"
bash "$project_dir/package.sh"
python3 "$project_dir/install-backend.py"
gnome-extensions install --force \
    "$project_dir/dist/$uuid.shell-extension.zip"

# Both UUIDs share the saved setting and lease file; never enable both.
if gnome-extensions info "$legacy_uuid" >/dev/null 2>&1; then
    gnome-extensions disable "$legacy_uuid"
fi

echo 'Touchpad Scroll Speed installed for your user.'
if gnome-extensions info "$uuid" >/dev/null 2>&1; then
    if gnome-extensions enable "$uuid"; then
        echo 'Extension enabled. Log out and back in to load the scroll component.'
    else
        echo 'Enable it from the Installed tab in the Extensions app.'
    fi
else
    echo 'Log out and back in, then enable it in the Installed tab in the Extensions app.'
fi

echo 'After signing back in, use the touchpad icon to adjust scrolling from 5% to 150%: 40% slow, 100% normal, 150% fast.'
