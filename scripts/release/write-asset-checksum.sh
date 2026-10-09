#!/usr/bin/env bash
# Write "<file>.sha256" next to a release asset in the standard `sha256sum -c`
# format (hash, two spaces, bare file name), so a downloader can verify with
# `sha256sum -c AutoMobile-X-linux.deb.sha256` from the download directory.
# Used by release.yml for the Linux .deb (#4726). Prints the checksum file path.
# Usage: write-asset-checksum.sh <file>
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: write-asset-checksum.sh <file>" >&2
  exit 2
fi
file="$1"
if [[ ! -f "$file" ]]; then
  echo "Release asset not found: $file" >&2
  exit 1
fi

dir="$(dirname "$file")"
name="$(basename "$file")"
out="$file.sha256"

if command -v sha256sum > /dev/null 2>&1; then
  hash_cmd=(sha256sum)
else
  hash_cmd=(shasum -a 256)
fi
# Hash from inside the directory so the checksum file records the bare name.
(cd "$dir" && "${hash_cmd[@]}" "$name") > "$out"
echo "$out"
