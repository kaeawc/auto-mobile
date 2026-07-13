#!/usr/bin/env bash

set -euo pipefail

constants_path="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/constants/release.ts"
release_version="${RELEASE_VERSION:-}"
apk_checksum="${APK_SHA256_CHECKSUM:-}"
ios_checksum="${IOS_CTRL_PROXY_SHA256_CHECKSUM:-}"
ios_app_hash="${IOS_CTRL_PROXY_APP_HASH:-}"
ios_runner_sha256="${IOS_CTRL_PROXY_RUNNER_SHA256:-}"

max_registry_entries=100

# Determine mode:
#   - All three set: add new registry entry
#   - Checksums only (no version): update registry[0] checksums in place
#   - Nothing set: no-op
has_checksums=false
if [ -n "$apk_checksum" ] || [ -n "$ios_checksum" ]; then
  has_checksums=true
fi

if [ -z "$release_version" ] && [ "$has_checksums" = "false" ]; then
  echo "INFO: No release environment variables set - using default constants"
  exit 0
fi

# Validate checksums
if [ -n "$apk_checksum" ] && ! [[ "$apk_checksum" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: APK_SHA256_CHECKSUM must be a valid SHA256 hash (64 hex characters)"
  echo "   Got: ${apk_checksum}"
  exit 1
fi

if [ -n "$ios_checksum" ] && ! [[ "$ios_checksum" =~ ^[a-f0-9]{64}$ ]]; then
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

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

cp "$constants_path" "$tmp_file"

sed_inplace() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i "" "$@"
  else
    sed -i "$@"
  fi
}

sed_inplace_extended() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -E -i "" "$@"
  else
    sed -E -i "$@"
  fi
}

prepend_registry_entry() {
  local file="$1"
  local entry="$2"
  local marker="export const RELEASE_CHECKSUM_REGISTRY: ReleaseChecksumEntry[] = ["
  local next_file
  local inserted=false
  next_file="$(mktemp)"

  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line"
    if [ "$line" = "$marker" ]; then
      printf '%s\n' "$entry"
      inserted=true
    fi
  done < "$file" > "$next_file"

  if [ "$inserted" != true ]; then
    rm -f "$next_file"
    echo "ERROR: Failed to locate RELEASE_CHECKSUM_REGISTRY marker in ${file}"
    exit 1
  fi

  mv "$next_file" "$file"
}

update_registry_field() {
  local file="$1"
  local version="$2"
  local field="$3"
  local value="$4"

  python3 - "$file" "$version" "$field" "$value" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = sys.argv[2]
field = sys.argv[3]
value = sys.argv[4]
text = path.read_text()

if version == "__FIRST__":
    match = re.search(r'(\{\n\s+version: "[^"]+",\n.*?\n\s+\})', text, re.S)
else:
    match = re.search(r'(\{\n\s+version: "' + re.escape(version) + r'",\n.*?\n\s+\})', text, re.S)

if not match:
    sys.stderr.write(f"failed to locate release registry entry for {version}\n")
    sys.exit(1)

entry = match.group(1)
field_re = re.compile(r'(^\s+' + re.escape(field) + r': ")[^"]*(",?$)', re.M)
if field_re.search(entry):
    updated_entry = field_re.sub(r'\g<1>' + value + r'\2', entry, count=1)
else:
    ipa_re = re.compile(r'(^\s+ipaSha256: "[^"]+",\n)', re.M)
    updated_entry = ipa_re.sub(r'\1    ' + field + f': "{value}",\n', entry, count=1)

path.write_text(text[:match.start(1)] + updated_entry + text[match.end(1):])
PY
}

if [ -n "$release_version" ]; then
  # Mode: add new registry entry (requires all three)
  if [ -z "$apk_checksum" ] || [ -z "$ios_checksum" ]; then
    echo "ERROR: RELEASE_VERSION requires both APK_SHA256_CHECKSUM and IOS_CTRL_PROXY_SHA256_CHECKSUM"
    exit 1
  fi

  if grep -q "version: \"${release_version}\"" "$constants_path"; then
    # Version already registered — do NOT duplicate the entry, but fall through
    # to the per-entry runner-sha update below. The release
    # job re-runs this after prepare-release already added the entry; skipping
    # entirely would leave runnerSha256 empty (verification disabled) whenever
    # prepare-release predates the runner-sha wiring.
    echo "INFO: Version ${release_version} already in registry — refreshing scalar constants only"
  else
    new_entry="  {
    version: \"${release_version}\",
    apkSha256: \"${apk_checksum}\",
    ipaSha256: \"${ios_checksum}\",
    runnerSha256: \"${ios_runner_sha256}\",
  },"

    # Prepend new entry after the opening bracket of RELEASE_CHECKSUM_REGISTRY
    prepend_registry_entry "$tmp_file" "$new_entry"

    # Cap registry at max_registry_entries
    entry_count=$(grep -c 'version: "' "$tmp_file" || true)
    if [ "$entry_count" -gt "$max_registry_entries" ]; then
      excess=$((entry_count - max_registry_entries))
      for ((i = 0; i < excess; i++)); do
        last_version_line=$(grep -n 'version: "' "$tmp_file" | tail -1 | cut -d: -f1)
        start_line=$((last_version_line - 1))
        end_line=$((last_version_line + 4))
        sed_inplace "${start_line},${end_line}d" "$tmp_file"
      done
    fi

    echo "Updated release constants:"
    echo "   Added registry entry for version: ${release_version}"
    echo "   APK checksum: ${apk_checksum}"
    echo "   iOS checksum: ${ios_checksum}"
  fi
else
  # Mode: update registry[0] checksums in place (nightly/checksum-only).
  #
  # Scope every field update to the first registry ENTRY (the block beginning
  # with `version: "`) via update_registry_field. A plain line-based match
  # collides with the `ReleaseChecksumEntry` interface declarations
  # (`apkSha256: string;` / `ipaSha256: string;`) that precede the registry:
  # `grep 'apkSha256:' | head -1` returns the type line, and the follow-up sed
  # (which only matches a 64-hex value) then silently updates nothing. That left
  # APK/IPA registry[0] stale while only runnerSha256 moved — see nightly PR
  # #3784, where the merged entry carried a fresh runner sha but original APK/IPA
  # shas, breaking whole-bundle vs runner verification for a fresh install.
  if [ -n "$apk_checksum" ]; then
    update_registry_field "$tmp_file" "__FIRST__" "apkSha256" "$apk_checksum"
  fi

  if [ -n "$ios_checksum" ]; then
    update_registry_field "$tmp_file" "__FIRST__" "ipaSha256" "$ios_checksum"
  fi

  if [ -n "$ios_runner_sha256" ]; then
    update_registry_field "$tmp_file" "__FIRST__" "runnerSha256" "$ios_runner_sha256"
  fi

  echo "Updated release constants:"
  if [ -n "$apk_checksum" ]; then
    echo "   APK checksum (registry[0]): ${apk_checksum}"
  fi
  if [ -n "$ios_checksum" ]; then
    echo "   iOS checksum (registry[0]): ${ios_checksum}"
  fi
fi

# Update optional scalar constants
if [ -n "$ios_app_hash" ]; then
  sed_inplace_extended "s/^export const IOS_CTRL_PROXY_APP_HASH: string = \".*\";/export const IOS_CTRL_PROXY_APP_HASH: string = \"${ios_app_hash}\";/" "$tmp_file"
  echo "   iOS app hash: ${ios_app_hash}"
fi

if [ -n "$ios_runner_sha256" ]; then
  if [ -n "$release_version" ]; then
    update_registry_field "$tmp_file" "$release_version" "runnerSha256" "$ios_runner_sha256"
  fi
  echo "   iOS runner SHA256: ${ios_runner_sha256}"
fi

if cmp -s "$constants_path" "$tmp_file"; then
  echo "INFO: Release constants already up to date"
  exit 0
fi

mv "$tmp_file" "$constants_path"
trap - EXIT

echo "   File: ${constants_path}"
