#!/usr/bin/env bash
# Proves the bounded iOS user_files provider and independent picker verifier from #5807.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
device_id="${1:-}"
app_id="dev.jasonpearson.automobile.files-fixture-provider"
fixture_content="picker fixture $RANDOM-$$-$(date +%s)"
derived_data="$(mktemp -d "${TMPDIR:-/tmp}/auto-mobile-ios-files-picker.XXXXXX")"

cleanup() {
  find "$derived_data" -depth -delete
}
trap cleanup EXIT

if [[ -z "$device_id" ]]; then
  device_id="$(xcrun simctl list devices booted | awk -F '[()]' '/iPhone|iPad/ { print $2; exit }')"
fi

if [[ -z "$device_id" ]]; then
  echo "No booted iOS Simulator found. Pass its UDID as the first argument." >&2
  exit 1
fi

xcrun simctl bootstatus "$device_id" -b
# The app is dedicated test infrastructure. Removing it first proves the
# production putAppFile provider can build and install its packaged project on
# first use instead of relying on this smoke to preinstall it.
xcrun simctl uninstall "$device_id" "$app_id" >/dev/null 2>&1 || true

stage_fixture() {
  local expected_picker_status="$1"
  # The single-quoted program is intentional: JavaScript template literals must
  # reach Bun unchanged rather than expand in the host shell.
  # shellcheck disable=SC2016
  AUTOMOBILE_PICKER_SMOKE_CONTENT="$fixture_content" bun -e '
    import { createAppFileServiceForTesting } from "./src/server/appFileService";
    const deviceId = process.argv[1];
    const expectedPickerStatus = process.argv[2];
    const content = process.env.AUTOMOBILE_PICKER_SMOKE_CONTENT;
    if (!deviceId || !expectedPickerStatus || !content) throw new Error("smoke inputs are required");
    const service = createAppFileServiceForTesting();
    const result = await service.putFile({
      device: { deviceId, name: deviceId, platform: "ios" as const },
      target: { domain: "user_files", namespace: "issue-5807-smoke", reset: false },
      files: [{ destinationPath: "issue-5807-fixture.txt", contentText: content }],
    });
    const effects = result.files[0]?.effects ?? [];
    if (!effects.some((effect) => effect.type === "host_stage" && effect.status === "completed")) {
      throw new Error(`putAppFile did not complete host staging: ${JSON.stringify(result)}`);
    }
    const picker = effects.find((effect) => effect.type === "document_picker");
    if (picker?.status !== expectedPickerStatus) {
      throw new Error(`expected picker ${expectedPickerStatus}, got ${JSON.stringify(result)}`);
    }
  ' "$device_id" "$expected_picker_status"
}

# A unique payload cannot match a stale provider-authored marker, so the first
# write proves host staging does not infer picker visibility.
stage_fixture unavailable

# Build the UI-test runner only after putAppFile has independently built and
# installed the runtime provider.
xcodebuild \
  -project "$repo_root/ios/FilesFixtureProvider/FilesFixtureProvider.xcodeproj" \
  -scheme FilesFixtureProviderPickerSmoke \
  -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath "$derived_data" \
  build-for-testing

xcrun simctl launch "$device_id" "$app_id" >/dev/null
xcrun simctl terminate "$device_id" "$app_id"

xcodebuild \
  -project "$repo_root/ios/FilesFixtureProvider/FilesFixtureProvider.xcodeproj" \
  -scheme FilesFixtureProviderPickerSmoke \
  -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath "$derived_data" \
  -only-testing:FilesFixtureProviderUITests \
  test-without-building

# The app records the selected logical path plus exact content hash. Restaging
# the same bytes now proves the verifier observed this specific fixture.
stage_fixture completed

echo "iOS putAppFile Files picker smoke passed for $device_id"
