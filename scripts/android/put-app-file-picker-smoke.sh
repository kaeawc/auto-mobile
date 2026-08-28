#!/usr/bin/env bash
# Verifies the Android putAppFile picker-fixture providers on a booted emulator.
set -euo pipefail

device_id="${1:-emulator-5554}"
document_name="issue-5804-document.txt"
media_name="issue-5804-image.png"
document_dump="/sdcard/automobile-issue-5804-document.xml"
media_dump="/sdcard/automobile-issue-5804-media.xml"

if ! adb -s "$device_id" get-state | grep -qx "device"; then
  echo "Android device is not ready: $device_id" >&2
  exit 1
fi

bun -e '
  import { createAppFileServiceForTesting } from "./src/server/appFileService";
  const deviceId = process.argv[1];
  if (!deviceId) throw new Error("device ID is required");
  const service = createAppFileServiceForTesting();
  const device = { deviceId, name: deviceId, platform: "android" as const };
  const document = await service.putFile({
    device,
    target: { domain: "user_files", namespace: "issue-5804-smoke", reset: true },
    files: [{ destinationPath: "documents/issue-5804-document.txt", contentText: "picker fixture" }],
  });
  const media = await service.putFile({
    device,
    target: { domain: "media_library" },
    files: [{
      destinationPath: "issue-5804-image.png",
      contentBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6WQAAAABJRU5ErkJggg==",
    }],
  });
  if (document.files[0]?.effects[0]?.type !== "document_picker") {
    throw new Error("putAppFile did not report document-picker availability");
  }
  if (media.files[0]?.effects[0]?.status !== "completed") {
    throw new Error("putAppFile did not verify MediaStore discovery");
  }
' "$device_id"

adb -s "$device_id" shell am force-stop com.google.android.documentsui
adb -s "$device_id" shell am start \
  -a android.intent.action.OPEN_DOCUMENT \
  -c android.intent.category.OPENABLE \
  -t text/plain \
  --eu android.provider.extra.INITIAL_URI \
  content://com.android.externalstorage.documents/document/primary%3ADownload%2Fissue-5804-smoke%2Fdocuments >/dev/null
adb -s "$device_id" shell uiautomator dump "$document_dump" >/dev/null
adb -s "$device_id" shell cat "$document_dump" | grep -Fq "${document_name}"

adb -s "$device_id" shell "content query --uri content://media/external_primary/images/media --projection _id:_display_name:relative_path --where \"_display_name='${media_name}' AND relative_path='Download/automobile-media/'\"" | grep -Fq "$media_name"
adb -s "$device_id" shell am start -a android.provider.action.PICK_IMAGES >/dev/null
adb -s "$device_id" shell uiautomator dump "$media_dump" >/dev/null
adb -s "$device_id" shell cat "$media_dump" | grep -Fq "com.google.android.providers.media.module"
adb -s "$device_id" shell am force-stop com.google.android.documentsui
adb -s "$device_id" shell am start \
  -a android.intent.action.OPEN_DOCUMENT \
  -c android.intent.category.OPENABLE \
  -t image/png \
  --eu android.provider.extra.INITIAL_URI \
  content://com.android.externalstorage.documents/document/primary%3ADownload%2Fautomobile-media >/dev/null
adb -s "$device_id" shell uiautomator dump "$media_dump" >/dev/null
adb -s "$device_id" shell cat "$media_dump" | grep -Fq "${media_name}"

echo "putAppFile picker smoke passed for $device_id"
