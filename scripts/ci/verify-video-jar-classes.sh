#!/usr/bin/env bash
# Assert the built video-server DEX jar contains the classes the on-device
# encoder needs (#5153: a jar missing VideoStatsAccumulator shipped without
# VIDEO_STATS). The jar is produced by d8, so it holds classes.dex rather than
# .class entries; class presence is checked via the DEX type descriptors
# (e.g. Ldev/jasonpearson/automobile/video/VideoServer;).
#
# Usage: verify-video-jar-classes.sh <path-to-automobile-video.jar>
set -euo pipefail

JAR_PATH="${1:?Usage: verify-video-jar-classes.sh <jar-path>}"
PACKAGE_PATH="dev/jasonpearson/automobile/video"
REQUIRED_CLASSES=(VideoServer VideoStatsAccumulator)

if [ ! -f "$JAR_PATH" ]; then
  echo "ERROR: video-server jar not found at $JAR_PATH" >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/video-jar-classes.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

if ! unzip -l "$JAR_PATH" >"$work_dir/listing" 2>"$work_dir/err"; then
  echo "ERROR: $JAR_PATH is not a readable zip: $(cat "$work_dir/err")" >&2
  exit 1
fi

# Collect every DEX (classes.dex, classes2.dex, ...) into one file to grep.
dex_entries="$(awk '$NF ~ /^classes[0-9]*\.dex$/ {print $NF}' "$work_dir/listing")"
if [ -z "$dex_entries" ]; then
  echo "ERROR: $JAR_PATH contains no classes.dex entry" >&2
  exit 1
fi
: >"$work_dir/all.dex"
while IFS= read -r entry; do
  unzip -p "$JAR_PATH" "$entry" >>"$work_dir/all.dex"
done <<<"$dex_entries"

missing=0
for cls in "${REQUIRED_CLASSES[@]}"; do
  if grep -aqF "L${PACKAGE_PATH}/${cls};" "$work_dir/all.dex"; then
    echo "OK: ${PACKAGE_PATH//\//.}.${cls} present in $(basename "$JAR_PATH")"
  else
    echo "ERROR: ${PACKAGE_PATH//\//.}.${cls} missing from $JAR_PATH" >&2
    missing=1
  fi
done

exit "$missing"
