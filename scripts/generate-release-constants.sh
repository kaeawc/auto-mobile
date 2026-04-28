#!/usr/bin/env bash

set -euo pipefail

constants_path="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/constants/release.ts"
release_version="${RELEASE_VERSION:-}"
apk_checksum="${APK_SHA256_CHECKSUM:-}"
ios_checksum="${IOS_CTRL_PROXY_SHA256_CHECKSUM:-}"
ios_app_hash="${IOS_CTRL_PROXY_APP_HASH:-}"
ios_runner_sha256="${IOS_CTRL_PROXY_RUNNER_SHA256:-}"

max_registry_entries=100

if [ -z "$release_version" ] || [ -z "$apk_checksum" ] || [ -z "$ios_checksum" ]; then
  echo "INFO: RELEASE_VERSION, APK_SHA256_CHECKSUM, and IOS_CTRL_PROXY_SHA256_CHECKSUM are all required"
  echo "   Set all three to add a new registry entry"
  exit 0
fi

if ! [[ "$apk_checksum" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: APK_SHA256_CHECKSUM must be a valid SHA256 hash (64 hex characters)"
  echo "   Got: ${apk_checksum}"
  exit 1
fi

if ! [[ "$ios_checksum" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: IOS_CTRL_PROXY_SHA256_CHECKSUM must be a valid SHA256 hash (64 hex characters)"
  echo "   Got: ${ios_checksum}"
  exit 1
fi

if [ -n "$ios_app_hash" ] && ! [[ "$ios_app_hash" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: IOS_CTRL_PROXY_APP_HASH must be a valid SHA256 hash (64 hex characters)"
  echo "   Got: ${ios_app_hash}"
  exit 1
fi

if [ -n "$ios_runner_sha256" ] && ! [[ "$ios_runner_sha256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: IOS_CTRL_PROXY_RUNNER_SHA256 must be a valid SHA256 hash (64 hex characters)"
  echo "   Got: ${ios_runner_sha256}"
  exit 1
fi

if grep -q "version: \"${release_version}\"" "$constants_path"; then
  echo "INFO: Version ${release_version} already exists in registry — skipping"
  exit 0
fi

new_entry="  {
    version: \"${release_version}\",
    apkSha256: \"${apk_checksum}\",
    ipaSha256: \"${ios_checksum}\",
  },"

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

cp "$constants_path" "$tmp_file"

# Prepend new entry after the opening bracket of RELEASE_CHECKSUM_REGISTRY
# Match the line "export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry[] = ["
# and insert the new entry on the next line
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i "" "/^export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry\[\] = \[$/a\\
${new_entry}
" "$tmp_file"
else
  sed -i "/^export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry\[\] = \[$/a\\
${new_entry}" "$tmp_file"
fi

# Cap registry at max_registry_entries by counting entries and removing excess from the end
entry_count=$(grep -c 'version: "' "$tmp_file" || true)
if [ "$entry_count" -gt "$max_registry_entries" ]; then
  excess=$((entry_count - max_registry_entries))
  # Remove the last N entries (each entry is 5 lines: {, version, apkSha256, ipaSha256, },)
  for ((i = 0; i < excess; i++)); do
    # Find the last occurrence of a registry entry block and remove it
    # Work backwards: find last "  }," before "];" and remove the 5-line block
    if [[ "$(uname)" == "Darwin" ]]; then
      # Find the line number of the last "version:" in the registry
      last_version_line=$(grep -n 'version: "' "$tmp_file" | tail -1 | cut -d: -f1)
      # The block starts 1 line before (the "{" line) and ends 2 lines after (the "}," line)
      start_line=$((last_version_line - 1))
      end_line=$((last_version_line + 3))
      sed -i "" "${start_line},${end_line}d" "$tmp_file"
    else
      last_version_line=$(grep -n 'version: "' "$tmp_file" | tail -1 | cut -d: -f1)
      start_line=$((last_version_line - 1))
      end_line=$((last_version_line + 3))
      sed -i "${start_line},${end_line}d" "$tmp_file"
    fi
  done
fi

# Update optional scalar constants
if [ -n "$ios_app_hash" ]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -E -i "" "s/^export const IOS_CTRL_PROXY_APP_HASH: string = \".*\";/export const IOS_CTRL_PROXY_APP_HASH: string = \"${ios_app_hash}\";/" "$tmp_file"
  else
    sed -E -i "s/^export const IOS_CTRL_PROXY_APP_HASH: string = \".*\";/export const IOS_CTRL_PROXY_APP_HASH: string = \"${ios_app_hash}\";/" "$tmp_file"
  fi
fi

if [ -n "$ios_runner_sha256" ]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -E -i "" "s/^export const IOS_CTRL_PROXY_RUNNER_SHA256: string = \".*\";/export const IOS_CTRL_PROXY_RUNNER_SHA256: string = \"${ios_runner_sha256}\";/" "$tmp_file"
  else
    sed -E -i "s/^export const IOS_CTRL_PROXY_RUNNER_SHA256: string = \".*\";/export const IOS_CTRL_PROXY_RUNNER_SHA256: string = \"${ios_runner_sha256}\";/" "$tmp_file"
  fi
fi

if cmp -s "$constants_path" "$tmp_file"; then
  echo "INFO: Release constants already up to date"
  exit 0
fi

mv "$tmp_file" "$constants_path"
trap - EXIT

echo "Updated release constants:"
echo "   Added registry entry for version: ${release_version}"
echo "   APK checksum: ${apk_checksum}"
echo "   iOS checksum: ${ios_checksum}"
if [ -n "$ios_app_hash" ]; then
  echo "   iOS app hash: ${ios_app_hash}"
fi
if [ -n "$ios_runner_sha256" ]; then
  echo "   iOS runner SHA256: ${ios_runner_sha256}"
fi
echo "   File: ${constants_path}"
