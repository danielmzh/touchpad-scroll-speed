#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"
read -r uuid release_version < <(python3 -c 'import json; m=json.load(open("extension/metadata.json")); print(m["uuid"], m["version-name"])')
if [[ ! "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo 'version-name must use MAJOR.MINOR.PATCH for release archives.' >&2
    exit 1
fi

bash ./build-backend.sh
bash ./package.sh
archive="touchpad-scroll-speed-$release_version"
tar --exclude='__pycache__' --exclude='*.pyc' \
    --exclude='extension/schemas/gschemas.compiled' --exclude='extension/locale' \
    --transform="s,^,$archive/," \
    -czf "dist/$archive.tar.gz" \
    README.md LICENSE .gitignore \
    build-backend.sh build-translations.py package.sh release.sh install.sh install-backend.py \
    extension backend tests po
(cd dist && sha256sum "$archive.tar.gz" "$uuid.shell-extension.zip" > SHA256SUMS)
echo "Release files created in $project_dir/dist"
