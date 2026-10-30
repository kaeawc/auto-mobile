#!/usr/bin/env bash
# Re-capture the ProtoViewer artifact-policy fixtures (issue #14154) from real builds.
# Usage: scripts/release/capture-protoviewer-policy-fixtures.sh [--android] [--ios]
#   --android  needs `./gradlew :protoviewer:assembleRelease :control-proxy:assembleRelease` first
#              (in android/) and aapt2 (AAPT2, or ANDROID_HOME build-tools).
#   --ios      needs `scripts/ios/protoviewer-build.sh scratch/protoviewer` first and a macOS host
#              with plutil, codesign, nm and swiftc.
# Fixtures are the tools' real output; the only edits are the documented trims below. The bad
# iOS cases are made with the same Apple tools (plutil -insert, codesign --entitlements, swiftc -g).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixtures="${repo_root}/test/fixtures/protoviewer-artifact-policy"

capture_android() {
  local aapt2="${AAPT2:-}"
  if [[ -z "${aapt2}" ]]; then
    aapt2="$(find "${ANDROID_HOME:?set ANDROID_HOME or AAPT2}/build-tools" -name aapt2 | sort | tail -n 1)"
  fi
  local name apk dir
  for name in protoviewer control-proxy; do
    apk="${repo_root}/android/${name}/build/outputs/apk/release/${name}-release.apk"
    dir="${fixtures}/android/${name}-release"
    mkdir -p "${dir}"
    "${aapt2}" dump xmltree --file AndroidManifest.xml "${apk}" > "${dir}/manifest.xmltree.txt"
    # Trim: only the `type xml` section of the resource table (resource id -> obfuscated file path).
    "${aapt2}" dump resources "${apk}" | awk '/^  type /{keep=($2=="xml")} keep' \
      > "${dir}/xml-resources.txt"
  done
  # CtrlProxy declares a network security config; capture the file the table resolves it to.
  local dir_cp="${fixtures}/android/control-proxy-release"
  local nsc_file
  nsc_file="$(awk '/xml\/network_security_config/{found=1; next} found && /\(file\)/{print $3; exit}' \
    "${dir_cp}/xml-resources.txt")"
  "${aapt2}" dump xmltree --file "${nsc_file}" \
    "${repo_root}/android/control-proxy/build/outputs/apk/release/control-proxy-release.apk" \
    > "${dir_cp}/network-security-config.xmltree.txt"
}

capture_ios() {
  local app="${PROTOVIEWER_APP:-${repo_root}/scratch/protoviewer/ProtoViewer.app}"
  local dir="${fixtures}/ios/simulator-app" work
  work="$(mktemp -d)"
  trap 'rm -rf "${work}"' RETURN
  mkdir -p "${dir}" "${fixtures}/ios/ats-exception" "${fixtures}/ios/dev-signed" \
    "${fixtures}/ios/debug-info"
  plutil -convert json -o - "${app}/Info.plist" > "${dir}/info-plist.json"
  codesign -d --entitlements :- "${app}" > "${dir}/codesign-entitlements.txt" 2> /dev/null
  # Trim: the first 150 rows of `nm -a` plus every row naming a symbol the policy forbids.
  nm -a "${app}/ProtoViewer" > "${work}/nm-full.txt"
  { head -n 150 "${work}/nm-full.txt"; grep -E 'PrototypeServer|bootViewerHost' "${work}/nm-full.txt" | head -n 20; } \
    > "${dir}/nm-a.txt"

  # ATS exception: the real Info.plist plus the key the policy forbids.
  cp "${app}/Info.plist" "${work}/Info.plist"
  plutil -insert NSAppTransportSecurity -json '{"NSAllowsArbitraryLoads": true}' "${work}/Info.plist"
  plutil -convert json -o - "${work}/Info.plist" > "${fixtures}/ios/ats-exception/info-plist.json"

  # Development signing: the real app re-signed with get-task-allow.
  cp -R "${app}" "${work}/App.app"
  cat > "${work}/dev.entitlements" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>get-task-allow</key><true/><key>com.apple.developer.networking.wifi-info</key><true/></dict></plist>
PLIST
  codesign --force --sign - --entitlements "${work}/dev.entitlements" "${work}/App.app" 2> /dev/null
  codesign -d --entitlements :- "${work}/App.app" \
    > "${fixtures}/ios/dev-signed/codesign-entitlements.txt" 2> /dev/null

  # Debug info: a tiny binary linked with -g keeps its debug map (stab rows) in `nm -a`.
  printf 'print("hi")\n' > "${work}/main.swift"
  xcrun --sdk iphonesimulator swiftc -g -target arm64-apple-ios17.0-simulator \
    "${work}/main.swift" -o "${work}/debug-binary"
  nm -a "${work}/debug-binary" > "${fixtures}/ios/debug-info/nm-a.txt"
}

if [[ $# -eq 0 ]]; then
  set -- --android --ios
fi
for arg in "$@"; do
  case "${arg}" in
    --android) capture_android ;;
    --ios) capture_ios ;;
    *) echo "unknown option: ${arg}" >&2; exit 2 ;;
  esac
done
