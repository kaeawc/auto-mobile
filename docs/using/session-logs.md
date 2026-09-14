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
  {?container,paths,groupId,groupPaths,lastSeconds,level,maxBytes}
```

Each source is optional and selected by its query parameters. At least one
source is required. Unknown parameters, path traversal, and out-of-range bounds
are rejected before any device is touched.

| Source             | Parameters                 | Android                                                    | iOS Simulator                                             |
| ------------------ | -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| App-container logs | `paths` (+ `container`)    | `run-as` for private containers; shell for `externalFiles` | Files under the app's data container                      |
| App Group files    | `groupId` (+ `groupPaths`) | `unavailable`                                              | Lists the group container; `groupPaths` reads named files |
| Unified-log window | `lastSeconds` (+ `level`)  | `unavailable`                                              | `log show --last N --predicate <subsystem == appId …>`    |

- `container` defaults to `documents`; the same logical containers as
  `putAppFile` apply (`documents`, `library`, `cache`, `tmp`, `externalFiles`).
- `paths` and `groupPaths` are URL-encoded JSON arrays of relative paths (for
  example, `paths=["a.log","b.log"]`) in the canonical, recommended form;
  this is comma-safe for paths that contain commas. A comma-separated list
  (`paths=a.log,b.log`) or bare path (`paths=app.log`) remains accepted for
  backward compatibility, but cannot represent a path containing a comma (the
  unchanged legacy limitation). At most 32 paths are allowed per source.
- `lastSeconds` is 1–3600. `level` is `default`, `info` (adds `--info`), or
  `debug` (adds `--info --debug`).
- `maxBytes` bounds every returned entry (default 256 KiB, at most 4 MiB). Each
  entry reports `byteCount` (the full size) and `truncated`.
- The unified-log call is also bounded by a wall-clock timeout; expiry aborts
  `log show` and reports `status: "timedOut"` for that source only.

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
`run-as`); a denied path reports `failed` with the reason. iOS is supported on
simulators only.
