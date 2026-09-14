# Session Downloads fixtures

Stage the files a system picker (documents, gallery, media) would open from the
device's shared **Downloads** tree, bound to the caller's device session. The
`stageSessionDownloads` tool is the session-scoped companion to
`stageSharedStorage`: instead of targeting a device by serial, every operation
is scoped to the live session that owns the device, and the tool refuses before
touching the device when that session is missing or no longer active.

## Tool

`stageSessionDownloads` (opt-in; enable with `--enable-tool stageSessionDownloads`).

| Field         | Type                      | Notes                                                                                                                 |
| ------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sessionUuid` | string (required)         | The live device session that owns the target Android device.                                                          |
| `directory`   | string (required)         | Exactly one child directory beneath Downloads; no separators, no `..`.                                                |
| `reset`       | boolean (default `false`) | Remove only that one directory before writing.                                                                        |
| `indexMedia`  | boolean (default `true`)  | Request Android media indexing for media files.                                                                       |
| `files`       | array (at least one)      | Each file provides exactly one of `sourcePath`, `contentText`, or `contentBase64`, plus a relative `destinationPath`. |

## Scope and safety

- **Android only.** iOS has no user-visible shared Downloads tree; an iOS
  session returns `{ success: false, status: "unavailable" }`.
- **Session-bound.** The device is resolved from `sessionUuid` through the same
  resolver the session-log family uses. A request without a bound session is
  refused with `SESSION_NOT_BOUND`, and one whose session no longer owns a
  device with `SESSION_NOT_ACTIVE` — both **before any device is touched**.
- **Downloads only.** `directory` is a single normalized segment, so `reset`
  can only ever remove `Downloads/<directory>`. `destinationPath` values are
  normalized and reject absolute paths and `..` traversal, so no fixture can
  escape the declared directory. Arbitrary shared-storage mutation is not
  exposed.

## Result

On success the tool reports the resolved `sessionUuid`, `deviceId`, the
`destinationDirectory` under the session device's active user, whether the
directory was `reset`, and a per-file entry with its `byteCount` and a
`mediaIndexing` outcome (`completed` when indexing was requested and confirmed,
otherwise `notRequested` with the reason).
