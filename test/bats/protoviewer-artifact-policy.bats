#!/usr/bin/env bats
# End-to-end CLI contract for the ProtoViewer release-artifact policy gate (issue #14154).
# aapt2, plutil, codesign and nm are PATH stubs that replay output captured from real builds
# (test/fixtures/protoviewer-artifact-policy), so the same assertions run on Linux and macOS.

setup() {
  repo_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  fixtures="$repo_root/test/fixtures/protoviewer-artifact-policy"
  work="$(mktemp -d)"
  stubs="$work/stubs"
  mkdir -p "$stubs"
  export FIXTURES="$fixtures"
  export PATH="$stubs:$PATH"

  # aapt2 <dump> <xmltree --file F | resources> <apk>: replay the fixture set named by $AAPT_FIXTURE.
  cat > "$stubs/aapt2" << 'STUB'
#!/usr/bin/env bash
dir="$FIXTURES/android/$AAPT_FIXTURE"
case "$*" in
  "dump xmltree --file AndroidManifest.xml "*) cat "$dir/manifest.xmltree.txt" ;;
  "dump xmltree --file res/8G.xml "*) cat "$dir/network-security-config.xmltree.txt" ;;
  "dump resources "*) cat "$dir/xml-resources.txt" ;;
  *) echo "aapt2 stub: unexpected $*" >&2; exit 9 ;;
esac
STUB
  # plutil reads Info.plist (replayed) or, for "-", the entitlements piped on stdin (replayed as JSON).
  cat > "$stubs/plutil" << 'STUB'
#!/usr/bin/env bash
if [[ "${*: -1}" == "-" ]]; then
  cat > /dev/null
  printf '%s' "${ENTITLEMENTS_JSON:-{\}}"
else
  cat "$FIXTURES/ios/$IOS_INFO_FIXTURE/info-plist.json"
fi
STUB
  cat > "$stubs/codesign" << 'STUB'
#!/usr/bin/env bash
cat "$FIXTURES/ios/$IOS_ENTITLEMENTS_FIXTURE/codesign-entitlements.txt"
STUB
  cat > "$stubs/nm" << 'STUB'
#!/usr/bin/env bash
cat "$FIXTURES/ios/$IOS_NM_FIXTURE/nm-a.txt"
STUB
  chmod +x "$stubs"/*
  export IOS_INFO_FIXTURE=simulator-app IOS_ENTITLEMENTS_FIXTURE=simulator-app IOS_NM_FIXTURE=simulator-app
}

teardown() {
  rm -rf "$work"
}

gate() {
  (cd "$repo_root" && bun scripts/release/check-protoviewer-artifact-policy.ts "$@")
}

@test "android: the real ProtoViewer release APK passes" {
  AAPT_FIXTURE=protoviewer-release run gate android "$work/app.apk" --allow-snapshot --aapt2 aapt2
  [ "$status" -eq 0 ]
  [[ "$output" == *"policy passed"* ]]
}

@test "android: a -SNAPSHOT versionName fails a release build" {
  AAPT_FIXTURE=protoviewer-release run gate android "$work/app.apk" --aapt2 aapt2
  [ "$status" -eq 1 ]
  [[ "$output" == *"[android.versionName]"* ]]
}

@test "android: allowBackup=true and an extra permission fail (the CtrlProxy posture)" {
  AAPT_FIXTURE=control-proxy-release run gate android "$work/app.apk" --allow-snapshot --aapt2 aapt2
  [ "$status" -eq 1 ]
  [[ "$output" == *"[android.allowBackup]"* ]]
  [[ "$output" == *"[android.permissions]"* ]]
  [[ "$output" == *"android.permission.QUERY_ALL_PACKAGES"* ]]
  [[ "$output" == *"[android.cleartext]"* ]]
}

@test "ios: the real simulator app passes, with the not-yet-landed rules as advisory warnings" {
  mkdir "$work/ProtoViewer.app"
  run gate ios "$work/ProtoViewer.app" --platform iphonesimulator
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARN [ios.privacyManifest]"* ]]
  [[ "$output" == *"advisory until #14151"* ]]
}

@test "ios: an .ipa whose Info.plist has NSAllowsArbitraryLoads fails" {
  command -v zip > /dev/null && command -v unzip > /dev/null || skip "zip and unzip are required"
  mkdir -p "$work/ipa/Payload/ProtoViewer.app"
  printf 'plist' > "$work/ipa/Payload/ProtoViewer.app/Info.plist"
  (cd "$work/ipa" && zip -qr "$work/ProtoViewer.ipa" Payload)
  IOS_INFO_FIXTURE=ats-exception run gate ios "$work/ProtoViewer.ipa" --platform iphonesimulator
  [ "$status" -eq 1 ]
  [[ "$output" == *"[ios.ats]"* ]]
  [[ "$output" == *"NSAllowsArbitraryLoads"* ]]
}

@test "ios: a development-signed app with get-task-allow fails" {
  mkdir "$work/ProtoViewer.app"
  IOS_ENTITLEMENTS_FIXTURE=dev-signed ENTITLEMENTS_JSON='{"get-task-allow":true}' \
    run gate ios "$work/ProtoViewer.app" --platform iphonesimulator
  [ "$status" -eq 1 ]
  [[ "$output" == *"forbidden entitlements present: get-task-allow"* ]]
}

@test "usage errors exit 2" {
  run gate android
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage:"* ]]
}
