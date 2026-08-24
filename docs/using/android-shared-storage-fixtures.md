# Android shared-storage fixtures

Use `stageSharedStorage` to place fixtures where Android system document and
media pickers can discover them. It is Android-only and resolves its target
through the normal device/session selection fields; callers do not need to use
ADB or choose a transport endpoint.

```json
{
  "name": "stageSharedStorage",
  "arguments": {
    "platform": "android",
    "namespace": "checkout-20260823",
    "reset": true,
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
Media files receive an Android media-scanner request by default; documents
report that indexing was not requested because the document picker discovers
files directly from Downloads. Set `indexMedia: false` to skip that request.

## Location and safety limits

The only supported destination is `/sdcard/Download/<namespace>`. A namespace
is one non-empty directory name—slashes, backslashes, and traversal segments
are rejected. File paths are relative to that namespace and cannot contain
`.` or `..` segments. With `reset: true`, AutoMobile removes only the exact
declared namespace before writing; it never resets Downloads itself or another
namespace.

This operation stages a known, small fixture set. It is not a general Android
filesystem API and does not provide arbitrary storage access or recursive
deletion outside its declared namespace.

## Diagnosing a target app

If the picker workflow still cannot use a target app after staging succeeds,
reuse the public installed-app inventory rather than looking for a second
package-list API. Read `automobile:apps?deviceId=<deviceId>&platform=android&search=<package>`
and check whether the expected package is present before debugging the app or
picker flow. See [Installed Apps](../design-docs/mcp/resources.md#installed-apps)
for query details.
