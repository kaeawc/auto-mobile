#!/usr/bin/env bash
# Build the Android CtrlProxy from source, install it, and print the env that
# pins a daemon to that build.
#
# Why this exists: the daemon verifies the installed APK's SHA256 against
# RELEASE_CHECKSUM_REGISTRY. A locally-built APK matches no registry entry, so a
# daemon started without the development-mode escape hatches treats it as
# unknown and reinstalls the released APK — silently downgrading your build and
# reverting any runner-gated feature you were trying to exercise.
#
# Usage:
#   scripts/local-dev/use-source-ctrl-proxy.sh              # build + install + print env
#   eval "$(scripts/local-dev/use-source-ctrl-proxy.sh --export)"   # ...and apply it here
#   SKIP_BUILD=true scripts/local-dev/use-source-ctrl-proxy.sh      # reuse existing APK

set -euo pipefail

ADB_SERIAL="${ADB_SERIAL:-}"
SKIP_BUILD="${SKIP_BUILD:-false}"
EXPORT_MODE="false"
[ "${1:-}" = "--export" ] && EXPORT_MODE="true"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APK="$REPO_ROOT/android/control-proxy/build/outputs/apk/debug/control-proxy-debug.apk"
SERVICE="dev.jasonpearson.automobile.ctrlproxy/dev.jasonpearson.automobile.ctrlproxy.CtrlProxy"

log() { [ "$EXPORT_MODE" = "true" ] || printf '==> %s\n' "$*"; }

adb_target() {
  if [ -n "$ADB_SERIAL" ]; then adb -s "$ADB_SERIAL" "$@"; else adb "$@"; fi
}

if [ "$SKIP_BUILD" != "true" ]; then
  log "Building control-proxy from source"
  # local.properties is gitignored and absent in fresh worktrees.
  if [ ! -f "$REPO_ROOT/android/local.properties" ]; then
    printf 'sdk.dir=%s\n' "${ANDROID_HOME:-$HOME/Library/Android/sdk}" \
      > "$REPO_ROOT/android/local.properties"
  fi
  # Send build chatter to stderr: in --export mode stdout is eval'd by the
  # caller, and Gradle emits plugin warnings even under -q.
  ( cd "$REPO_ROOT/android" && ./gradlew :control-proxy:assembleDebug --console=plain -q ) 1>&2
fi

[ -f "$APK" ] || { echo "APK not found: $APK" >&2; exit 1; }

log "Installing $(basename "$APK")"
adb_target install -r -d "$APK" >/dev/null 2>&1

# Reinstalling clears the enabled-services setting, so re-assert it. A freshly
# booted emulator also refuses to bind non-encryption-aware services until the
# keyguard is dismissed — unlock before relying on the service.
adb_target shell settings put secure enabled_accessibility_services "$SERVICE"
adb_target shell settings put secure accessibility_enabled 1

INSTALLED="$(adb_target shell dumpsys package dev.jasonpearson.automobile.ctrlproxy \
  | tr -d '\r' | grep -m1 'versionName' | tr -d ' ')"
log "Installed: ${INSTALLED:-unknown}  sha256: $(shasum -a 256 "$APK" | cut -c1-16)..."

if [ "$EXPORT_MODE" != "true" ]; then
  cat <<'EOF'

Start the daemon with these so it does not replace your build:

EOF
fi

# AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM is the documented development-mode knob;
# the other two keep the daemon pointed at this file and stop it re-downloading.
printf 'export AUTOMOBILE_CTRL_PROXY_APK_PATH=%q\n' "$APK"
printf 'export AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM=1\n'
printf 'export AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED=true\n'

if [ "$EXPORT_MODE" != "true" ]; then
  cat <<'EOF'

Note: any OTHER daemon on the shared socket that lacks these will reinstall the
released APK over this one. Check before trusting a runner-gated result:

  adb shell dumpsys package dev.jasonpearson.automobile.ctrlproxy | grep versionName
EOF
fi
