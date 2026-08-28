# Android shared-storage fixtures

Use `putAppFile` to place fixtures where Android system document and media
pickers can discover them. It is Android-only and resolves its target through
the normal device/session selection fields; callers do not need to use ADB or
choose a transport endpoint. `stageSharedStorage` remains available while
existing callers migrate and continues to use the same bounded Downloads
implementation.

```json
{
  "name": "putAppFile",
  "arguments": {
    "platform": "android",
    "target": {
      "domain": "user_files",
      "namespace": "checkout-20260823",
      "reset": true
    },
    "files": [
      {
        "destinationPath": "documents/terms.txt",
        "contentText": "Terms for this test run"
      },
      {
        "destinationPath": "media/receipt.png",
        "sourcePath": "/absolute/path/to/receipt.png"
      }
    ]
  }
}
```

Each request uses exactly one content source per file: `sourcePath` for a host
file, `contentText` for UTF-8 text, or `contentBase64` for binary data. The
result lists every logical destination, byte count, and media-indexing outcome.
Media files receive an Android media-scanner request by default, and the tool
waits until the corresponding media-provider row is visible before reporting
indexing as complete. Documents report that indexing was not requested because
the document picker discovers files directly from Downloads. The legacy
`stageSharedStorage` tool alone accepts `indexMedia: false`; `putAppFile`
always verifies media-library targets before reporting success.

## Location and safety limits

The only supported document-fixture destination is
`/storage/emulated/<resolved-user>/Download/<namespace>`. A namespace
is one non-empty directory name—slashes, backslashes, and traversal segments
are rejected. File paths are relative to that namespace and cannot contain
`.` or `..` segments. With `reset: true`, AutoMobile removes only the exact
declared namespace before writing; it never resets Downloads itself or another
namespace.

For an image, video, or audio fixture intended for Android's media picker, use
`target: { "domain": "media_library" }`. AutoMobile writes it beneath its
bounded `Download/automobile-media` namespace, requests a media scan, and only
reports the `media_index` effect as `completed` after MediaStore exposes the
file. The `user_files` result instead reports `document_picker` availability;
it also includes a media-index effect when the staged filename is media.

This operation stages a known, small fixture set. It is not a general Android
filesystem API and does not provide arbitrary storage access or recursive
deletion outside its declared namespace.

To run the device-backed picker smoke on a booted emulator, use
`scripts/android/put-app-file-picker-smoke.sh [device-id]`.

## Diagnosing a target app

If the picker workflow still cannot use a target app after staging succeeds,
reuse the public installed-app inventory rather than looking for a second
package-list API. Read `automobile:apps?deviceId=<deviceId>&platform=android&search=<package>`
and check whether the expected package is present before debugging the app or
picker flow. See [Installed Apps](../design-docs/mcp/resources.md#installed-apps)
for query details.
