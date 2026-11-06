#!/usr/bin/env bash
# Advisory smoke test for a visionOS (Apple Vision Pro) simulator.
#
# Creates its own Vision Pro simulator, boots it, builds a minimal SwiftUI fixture
# app with swiftc against the xrsimulator SDK, installs and launches it, captures a
# screenshot, and then terminates, uninstalls, shuts down and deletes its own device.
# It never touches a simulator it did not create.
#
# Not a required check. Runs from the nightly workflow and on PRs with the
# run-visionos-smoke label. See docs/using/visionos-simulator.md.
#
# Usage: smoke-visionos-simulator.sh [output-dir]
#   output-dir defaults to a fresh directory under $TMPDIR. Set SMOKE_RUNTIME to pick an
#   xrOS runtime identifier (default: the newest installed xrOS runtime).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_SRC="${SCRIPT_DIR}/fixtures/SmokeFixtureApp.swift"
BUNDLE_ID="dev.jasonpearson.automobile.VisionSmokeFixture"
EXECUTABLE="SmokeFixture"
DEVICE_TYPE="com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro-4K"
BOOT_TIMEOUT_S="${SMOKE_BOOT_TIMEOUT_S:-300}"

# Sourced helper: defines run_with_timeout (portable bound; 124 on expiry).
# shellcheck source=scripts/ios/run_with_timeout.sh
source "${SCRIPT_DIR}/../ios/run_with_timeout.sh"

log() { echo "[visionos-smoke] $*" >&2; }
die() { log "FAIL: $*"; exit 1; }

command -v xcrun >/dev/null 2>&1 || die "xcrun not found; this smoke test needs macOS with Xcode command-line tools"

OUT_DIR="${1:-$(mktemp -d "${TMPDIR:-/tmp}/visionos-smoke.XXXXXX")}"
mkdir -p "$OUT_DIR"
APP_DIR="${OUT_DIR}/${EXECUTABLE}.app"
UDID=""

cleanup() {
  local rc=$?
  if [[ -n "$UDID" ]]; then
    xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
    xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
    xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
    xcrun simctl delete "$UDID" >/dev/null 2>&1 || true
    log "deleted own simulator ${UDID}"
  fi
  exit "$rc"
}
trap cleanup EXIT

runtime_id() {
  if [[ -n "${SMOKE_RUNTIME:-}" ]]; then
    echo "$SMOKE_RUNTIME"
    return
  fi
  xcrun simctl list runtimes -j \
    | python3 -c 'import json,sys
rts=[r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable") and r["identifier"].split(".")[-1].startswith("xrOS")]
print(sorted(rts,key=lambda r: r["version"])[-1]["identifier"] if rts else "")'
}

RUNTIME="$(runtime_id)"
[[ -n "$RUNTIME" ]] || die "no available visionOS runtime; install one in Xcode > Settings > Platforms"
log "runtime ${RUNTIME}"

UDID="$(xcrun simctl create "AutoMobile visionOS smoke $(date +%s)" "$DEVICE_TYPE" "$RUNTIME")" \
  || die "simctl create failed for ${DEVICE_TYPE} on ${RUNTIME}"
log "created own simulator ${UDID}"

xcrun simctl boot "$UDID"
set +e
run_with_timeout "$BOOT_TIMEOUT_S" \
  xcrun simctl bootstatus "$UDID" -b >"${OUT_DIR}/bootstatus.log" 2>&1
boot_rc=$?
set -e
[[ "$boot_rc" -eq 0 ]] || die "boot did not finish within ${BOOT_TIMEOUT_S}s (see ${OUT_DIR}/bootstatus.log)"
log "booted"

mkdir -p "$APP_DIR"
xcrun --sdk xrsimulator swiftc -parse-as-library -target arm64-apple-xros26.5-simulator \
  -o "${APP_DIR}/${EXECUTABLE}" "$FIXTURE_SRC" >"${OUT_DIR}/swiftc.log" 2>&1 \
  || die "swiftc failed (see ${OUT_DIR}/swiftc.log)"

cat >"${APP_DIR}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${EXECUTABLE}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleSupportedPlatforms</key><array><string>XRSimulator</string></array>
  <key>MinimumOSVersion</key><string>26.5</string>
  <key>UIDeviceFamily</key><array><integer>7</integer></array>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP_DIR" >"${OUT_DIR}/codesign.log" 2>&1 \
  || die "ad-hoc codesign failed (see ${OUT_DIR}/codesign.log)"

xcrun simctl install "$UDID" "$APP_DIR" || die "simctl install failed"
log "installed ${BUNDLE_ID}"

xcrun simctl launch "$UDID" "$BUNDLE_ID" >"${OUT_DIR}/launch.log" 2>&1 || die "simctl launch failed"
sleep 5
apps="$(xcrun simctl listapps "$UDID")"
[[ "$apps" == *"$BUNDLE_ID"* ]] || die "fixture not listed after install"
log "launched ${BUNDLE_ID}"

xcrun simctl io "$UDID" screenshot "${OUT_DIR}/screenshot.png" >/dev/null 2>&1 \
  || die "screenshot failed"
[[ -s "${OUT_DIR}/screenshot.png" ]] || die "screenshot file is empty"
log "PASS: screenshot at ${OUT_DIR}/screenshot.png"
