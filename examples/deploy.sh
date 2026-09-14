#!/usr/bin/env bash

# @probe staging => exit 1
# @probe ppr => exit 0
# @probe prod => exit 1
set -uo pipefail

target="${1:-}"
dest="releases/$target"

if [[ "$target" == "prod" ]]; then
  echo "refusing to deploy to prod from a probe" >&2
  exit 1
fi

mkdir -p "$dest"

for artifact in app.js styles.css readme.md; do
  cp "artifacts/$artifact" "$dest/"
done

echo "deployed $target" > "$dest/status.txt"
echo "deployed $target"
