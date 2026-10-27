# Session execution logs

Collect the diagnostic sources a test would otherwise reach with raw platform
commands (`adb shell run-as`, `xcrun simctl get_app_container`, `log show`)
through one session-scoped resource and one reset tool. Everything is bound to
the caller's device session: the URI names the session, the read must come from
the connection that owns that session, and the device is the one the session
holds. A read never resolves a caller-supplied serial and never constructs a
device client for a session it cannot serve.

## Resource

```text
automobile:device-session/{sessionUuid}/apps/{appId}/logs
  {?container,paths,pathsJson,groupId,groupPaths,groupPathsJson,lastSeconds,level,maxBytes}
```

Each source is optional and selected by its query parameters. At least one
source is required. Unknown parameters, path traversal, and out-of-range bounds
are rejected before any device is touched.

| Source             | Parameters                     | Android                                                    | iOS Simulator                                                 | Physical iOS                                      |
| ------------------ | ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| App-container logs | `pathsJson` (+ `container`)    | `run-as` for private containers; shell for `externalFiles` | Files under the app's data container                          | `unavailable`                                     |
| App Group files    | `groupId` (+ `groupPathsJson`) | `unavailable`                                              | Lists the group container; `groupPathsJson` reads named files | `unavailable`                                     |
| Unified-log window | `lastSeconds` (+ `level`)      | `unavailable`                                              | `log show --last N --predicate <subsystem == appId …>`        | Host `log collect --device-udid`, then `log show` |

- `container` defaults to `documents`; the same logical containers as
  `putAppFile` apply (`documents`, `library`, `cache`, `tmp`, `externalFiles`).
- `pathsJson` and `groupPathsJson` are the canonical, recommended URL-encoded
  JSON arrays of relative paths (for example,
  `pathsJson=["a.log","b.log"]`). They are comma/bracket/quote-safe for any
  legal path, including `[report]`, `["report"]`, `a,b.log`, and `100%.log`.
  The legacy `paths` and `groupPaths` comma-separated-or-bare-scalar form
  (`paths=a.log,b.log` or `paths=app.log`) remains accepted for backward
  compatibility, but cannot represent a path containing a comma. Legacy values
  are interpreted only as literal comma lists/scalars; bracket-looking text is
  never reinterpreted as JSON. At most 32 paths are allowed per source.
- `lastSeconds` is 1–3600. `level` is `default`, `info` (adds `--info`), or
  `debug` (adds `--info --debug`).
- `maxBytes` bounds every returned entry (default 256 KiB, at most 4 MiB). Each
  entry reports `byteCount` (the full size) and `truncated`.
- The unified-log call is also bounded by a wall-clock timeout; expiry aborts
  `log show` and reports `status: "timedOut"` for that source only.
- Every unified-log result reports `mechanism` (`simctl-log-show` or
  `log-collect`) and `collectionMs`, the wall-clock time the read took.

### Physical iOS devices

On a physical device the unified-log window runs on the macOS host:
`log collect --device-udid <udid> --last N --output <tmp>.logarchive` copies
the device's recent log store, then `log show` filters that archive with the
same predicate, `level` flags, and `maxBytes` bound as the Simulator path. The
archive is deleted after every read. Collection copies data from the device, so
it is slower than a Simulator read; the timeout for `log collect` plus
`log show` is 60 s. Keep `lastSeconds` short.

Known failures report a `code` beside the `reason`:

| `code`                 | `status`      | Meaning                                                 |
| ---------------------- | ------------- | ------------------------------------------------------- |
| `HOST_UNSUPPORTED`     | `unavailable` | The host is not macOS, so `log collect` does not exist. |
| `HOST_NOT_ADMIN`       | `failed`      | `log collect` must run from an administrator account.   |
| `DEVICE_NOT_CONNECTED` | `unavailable` | The device is not reachable over USB or the network.    |
| `DEVICE_NOT_PAIRED`    | `unavailable` | The device has not paired with and trusted this Mac.    |
| `DEVICE_LOCKED`        | `failed`      | The device is locked; unlock it and retry.              |

These codes are derived from the text of `log collect` errors and have not been
checked on real hardware.
Unrecognised failures report `failed` with the full command output.

Every source reports its own outcome, so a failed or unavailable source never
blocks the others:

```json
{
  "sessionUuid": "…",
  "deviceId": "AAAAAAAA-…",
  "platform": "ios",
  "appId": "com.example.app",
  "maxBytes": 262144,
  "files": {
    "status": "ok",
    "container": "cache",
    "entries": [
      {
        "path": "logs/app.log",
        "status": "read",
        "byteCount": 9120,
        "truncated": false,
        "text": "…"
      },
      { "path": "logs/net.log", "status": "missing" }
    ]
  },
  "appGroup": {
    "status": "failed",
    "reason": "Failed to read group.com.example.shared iOS simulator …"
  },
  "unifiedLog": {
    "status": "ok",
    "lastSeconds": 120,
    "level": "info",
    "predicate": "subsystem == \"com.example.app\" OR subsystem BEGINSWITH \"com.example.app.\"",
    "mechanism": "simctl-log-show",
    "collectionMs": 840,
    "timeoutMs": 20000,
    "byteCount": 48211,
    "truncated": false,
    "text": "…"
  }
}
```

Per-path statuses are `read`, `missing`, or `failed`; per-source statuses are
`ok`, `unavailable`, `failed`, or `timedOut`. Non-UTF-8 content is returned as a
base64 `blob` instead of `text`. Reads from a connection that does not own the
session, or for a session that is no longer active, return a JSON error
(`SESSION_NOT_BOUND`, `SESSION_NOT_ACTIVE`) without touching the device.

## Reset tool

`resetAppLogs` removes explicitly named log files and their rotated siblings
(`<path>.1`, `<path>.2`, …) from an app container on the session's device,
reporting a per-path outcome. It is disabled by default; enable it with
`setToolEnabled` when a flow needs a clean log before it starts.

```json
{
  "tool": "resetAppLogs",
  "params": {
    "appId": "com.example.app",
    "container": "documents",
    "paths": ["logs/app.log", "logs/net.log"]
  }
}
```

```json
{
  "success": true,
  "deviceId": "emulator-5554",
  "platform": "android",
  "appId": "com.example.app",
  "container": "documents",
  "entries": [
    { "path": "logs/app.log", "status": "reset" },
    { "path": "logs/net.log", "status": "missing" }
  ]
}
```

Android private containers require a debuggable build (the reset runs under
`run-as`); a denied path reports `failed` with the reason. iOS reset is supported
on simulators only.
