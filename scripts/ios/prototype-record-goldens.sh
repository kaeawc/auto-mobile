#!/usr/bin/env bash
# Record only on an explicitly supplied, already booted iPhone 16. Never owns its lifecycle.
set -euo pipefail

fail() { printf 'prototype-record-goldens: %s\n' "$*" >&2; exit 2; }
usage() {
  printf 'Usage: %s <simulator-udid> [--viewer <PrototypeViewer.app>] [--out <dir>] [golden-name ...]\n' "$0"
}
[[ $# -gt 0 && "$1" != -* ]] || { usage >&2; exit 2; }
udid="$1"
shift
# Compare case-insensitively so this exclusion cannot be bypassed by lower-case input.
[[ "$(printf '%s' "${udid}" | tr '[:lower:]' '[:upper:]')" != 18A2D9B1-CDFA-445A-93AA-A532EA4B5498 ]] || fail 'refusing the CI iPhone UDID'
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
viewer="${repo_root}/scratch/prototype-viewer/PrototypeViewer.app"
out="${repo_root}/ios/prototype-agent/Goldens/iphone-16"
names=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --viewer | --out)
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || fail "$1 needs a value"
      if [[ "$1" == --viewer ]]; then viewer="$2"; else out="$2"; fi
      shift 2
      ;;
    -*) fail "unknown option: $1" ;;
    *) names+=("$1"); shift ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || fail 'macOS is required'
[[ -d "${viewer}" ]] || fail "viewer app not found: ${viewer}; run scripts/ios/prototype-viewer-build.sh"
stable_max_captures="${PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES:-8}"
stable_budget_secs="${PROTOTYPE_GOLDEN_STABLE_BUDGET_SECS:-15}"
[[ "${stable_max_captures}" =~ ^[1-9][0-9]*$ ]] || fail 'PROTOTYPE_GOLDEN_STABLE_MAX_CAPTURES must be a positive integer'
[[ "${stable_budget_secs}" =~ ^(0|[1-9][0-9]*)$ ]] || fail 'PROTOTYPE_GOLDEN_STABLE_BUDGET_SECS must be a nonnegative integer'
for command in bun jq xcrun sips cmp date; do
  command -v "${command}" >/dev/null || fail "required command not found: ${command}"
done

devices="$(xcrun simctl list devices --json)"
device="$(jq -cer --arg udid "${udid}" '[.devices[][] | select((.udid | ascii_upcase) == ($udid | ascii_upcase))] | if length == 1 then .[0] else error("device not found or ambiguous") end' <<< "${devices}")" || fail "device does not exist: ${udid}"
[[ "$(jq -r '.state' <<< "${device}")" == Booted ]] || fail "device must already be Booted; run: xcrun simctl boot ${udid}"
[[ "$(jq -r '.deviceTypeIdentifier' <<< "${device}")" == com.apple.CoreSimulator.SimDeviceType.iPhone-16 ]] || fail 'device type must be iPhone 16'

mkdir -p "${repo_root}/scratch"
tmp_dir="$(mktemp -d "${repo_root}/scratch/ios-goldens.XXXXXX")"
bundle=dev.jasonpearson.automobile.prototype-viewer
restore=0
running=0
cleanup() {
  if [[ "${running}" == 1 ]]; then xcrun simctl terminate "${udid}" "${bundle}" >/dev/null 2>&1 || true; fi
  if [[ "${restore}" == 1 ]]; then
    xcrun simctl status_bar "${udid}" clear || true
    xcrun simctl ui "${udid}" appearance light || true
  fi
  rm -rf "${tmp_dir:?}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun "${repo_root}/scripts/prototype/ios-golden-specs.ts" "${tmp_dir}"
manifest="${tmp_dir}/cases.json"
jq -r '.cases[] | [.golden, .mode] | @tsv' "${manifest}" > "${tmp_dir}/all.tsv"
if [[ ${#names[@]} -gt 0 ]]; then
  : > "${tmp_dir}/selected.tsv"
  for name in "${names[@]}"; do
    jq -er --arg name "${name}" '.cases[] | select(.golden == $name) | [.golden, .mode] | @tsv' "${manifest}" >> "${tmp_dir}/selected.tsv" || fail "unknown golden: ${name}"
  done
else
  cp "${tmp_dir}/all.tsv" "${tmp_dir}/selected.tsv"
fi
width="$(jq -er '.width' "${manifest}")"
height="$(jq -er '.height' "${manifest}")"
crop_top="$(jq -er '.cropTopPx' "${manifest}")"
# sips -g emits labelled text, not JSON; only these two numeric properties are consumed.
check_size() {
  local image="$1" expected_width="$2" expected_height="$3" size
  size="$(sips -g pixelWidth -g pixelHeight "${image}")"
  [[ "$(awk '/pixelWidth:/ {print $2}' <<< "${size}")" == "${expected_width}" && "$(awk '/pixelHeight:/ {print $2}' <<< "${size}")" == "${expected_height}" ]] || fail "wrong screenshot size (expected ${expected_width}x${expected_height}): ${size}"
}
# Compare complete PNGs, including system chrome, before cropping the chosen capture.
capture_until_stable() {
  local golden="$1" captures=0 started
  started="$(date +%s)"
  sleep 0.5
  while (( captures < stable_max_captures && $(date +%s) - started < stable_budget_secs )); do
    xcrun simctl io "${udid}" screenshot --type=png "${tmp_dir}/screen.png"
    captures=$((captures + 1))
    if (( captures > 1 )) && cmp -s "${tmp_dir}/screen.png" "${tmp_dir}/screen.prev.png"; then
      printf 'prototype-record-goldens: %s: capture=stable (%s captures)\n' "${golden}" "${captures}" >&2
      return
    fi
    cp "${tmp_dir}/screen.png" "${tmp_dir}/screen.prev.png"
    if (( captures < stable_max_captures )); then sleep 0.5; fi
  done
  # Preserve the original settle-and-capture behavior when the bounded polling fails.
  sleep 2
  xcrun simctl io "${udid}" screenshot --type=png "${tmp_dir}/screen.png"
  printf 'prototype-record-goldens: %s: capture=fallback (not stable after %s captures)\n' "${golden}" "${captures}" >&2
}
mkdir -p "${out}"
restore=1
xcrun simctl status_bar "${udid}" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4 --operatorName ''
while IFS=$'\t' read -r golden mode; do
  xcrun simctl uninstall "${udid}" "${bundle}" >/dev/null 2>&1 || true # A fresh device may have no viewer.
  xcrun simctl install "${udid}" "${viewer}"
  xcrun simctl ui "${udid}" appearance "${mode}"
  container="$(xcrun simctl get_app_container "${udid}" "${bundle}" data)"
  [[ -n "${container}" && -d "${container}" ]] || fail 'viewer data container missing'
  mkdir -p "${container}/Documents/prototype"
  printf '%s\n' '{"formatVersion":1,"specFile":"spec.json","assets":[],"fonts":[]}' > "${container}/Documents/prototype/manifest.json"
  cp "${tmp_dir}/${golden}.json" "${container}/Documents/prototype/spec.json"
  running=1
  # Recording mode: fixed spinner frames, a pinned calendar locale and clock, no dialog entrance.
  xcrun simctl launch "${udid}" "${bundle}" --automobile-prototype-recording
  capture_until_stable "${golden}"
  check_size "${tmp_dir}/screen.png" 1179 2556
  # man sips: --cropOffset offsetY offsetH; --cropToHeightWidth pixelsH pixelsW.
  sips --cropOffset "${crop_top}" 0 --cropToHeightWidth "${height}" "${width}" "${tmp_dir}/screen.png" --out "${tmp_dir}/cropped.png" >/dev/null
  check_size "${tmp_dir}/cropped.png" "${width}" "${height}"
  cp "${tmp_dir}/cropped.png" "${out}/${golden}.png"
  xcrun simctl terminate "${udid}" "${bundle}"
  running=0
done < "${tmp_dir}/selected.tsv"
