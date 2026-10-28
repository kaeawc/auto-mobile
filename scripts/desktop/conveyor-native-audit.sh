#!/usr/bin/env bash
#
# Measures cross-platform native contamination in a built Conveyor package (#5543).
#
# The desktop runtime classpath carries the build machine's Skiko/ffmpeg natives, so Conveyor's
# common app.inputs can ship them to every platform. This reports, for one target package, how many
# bytes of jars and loose native libraries belong to a different OS or architecture, so the size
# win of trimming them can be weighed before touching the build. It only measures; it never edits.
#
# Usage:
#   conveyor-native-audit.sh --target <mac-amd64|mac-aarch64|linux-amd64|linux-arm64> \
#     [--max-foreign-bytes N] <package-dir | .zip | .tar.gz | .tgz | .deb>
#
# Exits 0 after reporting. With --max-foreign-bytes, exits 1 when foreign bytes exceed N.

set -euo pipefail

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

target=""
max_foreign=""
input=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      target="${2:-}"
      shift 2
      ;;
    --max-foreign-bytes)
      max_foreign="${2:-}"
      shift 2
      ;;
    -h | --help) usage ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      ;;
    *)
      input="$1"
      shift
      ;;
  esac
done

case "$target" in
  mac-amd64 | mac-aarch64 | linux-amd64 | linux-arm64) ;;
  *)
    echo "--target must be mac-amd64, mac-aarch64, linux-amd64 or linux-arm64" >&2
    usage
    ;;
esac
[[ -n "$input" && -e "$input" ]] || {
  echo "Package path not found: ${input:-<none>}" >&2
  usage
}
if [[ -n "$max_foreign" && ! "$max_foreign" =~ ^[0-9]+$ ]]; then
  echo "--max-foreign-bytes must be a non-negative integer" >&2
  exit 2
fi

workdir=""
cleanup() {
  [[ -n "$workdir" ]] && rm -rf "$workdir"
  return 0
}
trap cleanup EXIT

extract() {
  local archive="$1" dest="$2"
  case "$archive" in
    *.zip) unzip -q "$archive" -d "$dest" ;;
    *.tar.gz | *.tgz) tar -xzf "$archive" -C "$dest" ;;
    *.deb) dpkg-deb -x "$archive" "$dest" ;;
    *)
      echo "Unsupported archive type: $archive" >&2
      exit 2
      ;;
  esac
}

if [[ -d "$input" ]]; then
  root="$input"
else
  workdir="$(mktemp -d)"
  extract "$input" "$workdir"
  root="$workdir"
fi

# Prints "<os>-<arch>" for a file whose name pins a platform, "<os>" when only the OS is known
# (loose .so/.dylib/.dll), "all" for javacpp "-platform" meta jars, and nothing when neutral.
platform_of() {
  local name
  name="$(basename "$1" | tr '[:upper:]' '[:lower:]')"
  case "$name" in
    *-platform*.jar) echo "all" ;;
    *linux*x86_64* | *linux*x64* | *linux*amd64*) echo "linux-amd64" ;;
    *linux*arm64* | *linux*aarch64*) echo "linux-arm64" ;;
    *macosx*x86_64* | *macos*x64* | *macos*amd64* | *osx*x86_64* | *darwin*x86_64*) echo "mac-amd64" ;;
    *macos*arm64* | *osx*arm64* | *darwin*arm64* | *macos*aarch64*) echo "mac-aarch64" ;;
    *windows* | *win32*) echo "windows" ;;
    *.so | *.so.*) echo "linux" ;;
    *.dylib | *.jnilib) echo "mac" ;;
    *.dll) echo "windows" ;;
    *) ;;
  esac
}

is_foreign() {
  local platform="$1"
  case "$platform" in
    "") return 1 ;;
    all) return 0 ;;
    linux) [[ "$target" != linux-* ]] ;;
    mac) [[ "$target" != mac-* ]] ;;
    "$target") return 1 ;;
    *) return 0 ;;
  esac
}

total=0
foreign=0
foreign_lines=""
while IFS= read -r -d '' file; do
  size="$(wc -c <"$file" | tr -d ' ')"
  total=$((total + size))
  platform="$(platform_of "$file")"
  if is_foreign "$platform"; then
    foreign=$((foreign + size))
    foreign_lines+="$(printf '%12d  %-12s %s' "$size" "$platform" "${file#"$root"/}")"$'\n'
  fi
done < <(find "$root" -type f \( -name '*.jar' -o -name '*.so' -o -name '*.so.*' -o -name '*.dylib' -o -name '*.jnilib' -o -name '*.dll' \) -print0 | sort -z)

echo "Target: $target"
echo "Scanned jars + native libraries: $total bytes"
echo "Foreign to target:               $foreign bytes"
if [[ -n "$foreign_lines" ]]; then
  echo
  printf '%12s  %-12s %s\n' "bytes" "platform" "path"
  printf '%s' "$foreign_lines"
fi

if [[ -n "$max_foreign" ]] && ((foreign > max_foreign)); then
  echo "Foreign natives ($foreign bytes) exceed --max-foreign-bytes $max_foreign" >&2
  exit 1
fi
