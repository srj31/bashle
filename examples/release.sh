#!/usr/bin/env bash
# Downloads the latest release notes and files them under releases/.
# Nothing here reaches the network: bashle turns each curl into a hole.
#
# This probe leaves the download unanswered, so its answer shows up as ◇1.
# Follow it down the script, then look at the checksum line: that one is ◇!,
# because $mirror was empty and the "hole" is really a bug.
# @probe staging

# This probe answers the download, so ◇1 becomes 1.4.2 everywhere.

# @net GET https://releases.example.com/latest => "1.4.2"
# @probe prod

set -uo pipefail

target=$1
mirror=${MIRROR:-}

version=$(curl -fsS "https://releases.example.com/latest")
dest="releases/$target-$version"
mkdir -p "$dest"
echo "$version" > "$dest/VERSION"

checksum=$(curl -fsS "$mirror/checksums/$version")
echo "$checksum" > "$dest/SHA256"
echo "released $version to $target"
