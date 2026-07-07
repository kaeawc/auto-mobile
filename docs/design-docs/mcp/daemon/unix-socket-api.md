# Unix Socket API

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

The AutoMobile daemon exposes a Unix socket for IDE plugins and CLI clients to communicate with the daemon without going through MCP. See [Daemon Overview](index.md) for architecture context.

## Socket Path

```
/tmp/auto-mobile-daemon-<uid>.sock
```

The path can be overridden via the `AUTOMOBILE_DAEMON_SOCKET_PATH` or `AUTO_MOBILE_DAEMON_SOCKET_PATH` environment variables.
Consumers that launch the daemon themselves should pass one of those environment
variables to both the daemon and their client. Consumers attaching to the default
daemon can derive the path from the current user ID:

```bash
export AUTOMOBILE_DAEMON_SOCKET_PATH="/tmp/auto-mobile-daemon-$(id -u).sock"
```

## Protocol

All messages are newline-delimited JSON sent over the Unix socket. Each request receives exactly one response.

**Request**

```json
{
  "id": "unique-request-id",
  "type": "mcp_request",
  "method": "ide/ping",
  "params": {},
  "timeoutMs": 30000
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Caller-assigned ID echoed back in the response |
| `type` | `"mcp_request" \| "daemon_request"` | Yes | Request category |
| `method` | `string` | Yes | Endpoint name (e.g. `ide/ping`, `daemon/availableDevices`) |
| `params` | `object` | Yes | Method-specific parameters; pass `{}` when none are needed |
| `timeoutMs` | `number` | No | Per-request timeout in milliseconds (default: 30 000). Long-running `tools/call` requests may be raised to a tool-specific minimum timeout by the daemon (see [Tool-specific timeout floors](#tool-specific-timeout-floors)). |

**Response**

```json
{
  "id": "unique-request-id",
  "type": "mcp_response",
  "success": true,
  "result": { }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Echoed from the request |
| `type` | `"mcp_response"` | Always this value |
| `success` | `boolean` | `true` on success, `false` on error |
| `result` | `object` | Present when `success` is `true` |
| `error` | `string` | Present when `success` is `false` |

---

## IDE Endpoints

These are handled directly by the daemon process without forwarding to the MCP server.

### `ide/ping`

Liveness check. Returns immediately.

**Params:** none

**Result**

```json
{ "ok": true, "timestamp": 1718000000000 }
```

---

### `ide/status`

Returns daemon version and bundled service artifact information.

**Params:** none

**Result**

```json
{
  "version": "1.2.3",
  "releaseVersion": "1.2.3",
  "android": {
    "accessibilityService": {
      "expectedSha256": "abc123...",
      "url": "https://..."
    }
  },
  "ios": {
    "xcTestService": {
      "expectedSha256": "def456...",
      "expectedAppHash": "ghi789...",
      "url": "https://..."
    }
  }
}
```

### Version mismatch handling

The stdio MCP server and daemon are shipped from the same package version. When
the stdio proxy finds an already-running daemon, it compares the daemon version
from the PID metadata with the MCP server package version before connecting.

- Matching versions connect normally.
- If the MCP server version is newer than the daemon version, the proxy restarts
  the daemon when daemon auto-start/restart is enabled and the daemon has been
  running longer than the restart cooldown.
- If the running daemon is newer than the MCP server, the proxy fails before
  connecting and reports both versions rather than attaching an older client to
  newer daemon behavior.
- If auto-start/restart is disabled, the proxy fails before connecting and
  reports the client and daemon versions.
- If the daemon is inside the restart cooldown, the proxy fails before
  connecting and asks the client to retry after the cooldown or manually restart
  the daemon.
- Missing daemon version metadata is treated as stale and restarted when restart
  is allowed. Non-numeric versions such as prerelease tags or `unknown` fail
  before connecting because ordering is ambiguous.

The restart cooldown deliberately prevents multiple concurrent clients pinned to
different package versions from repeatedly restarting the shared daemon. During
that cooldown, mismatched clients must retry later rather than sending requests
to daemon code from another package version.

---

### `ide/listFeatureFlags`

Lists all available feature flags and their current state. See [Feature Flags](../feature-flags.md) for the full list of flags.

**Params:** none

**Result**

```json
{
  "flags": [
    { "key": "debugMode", "enabled": false, "config": null }
  ]
}
```

---

### `ide/setFeatureFlag`

Enables or disables a feature flag, with optional configuration.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | `string` | Yes | Feature flag key |
| `enabled` | `boolean` | Yes | Enable or disable the flag |
| `config` | `object \| null` | No | Optional flag-specific configuration |

**Result:** the updated feature flag object.

---

### `ide/updateService`

Updates the Android accessibility service APK or restarts the iOS CtrlProxy iOS on the target device.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `deviceId` | `string` | Yes | ADB device ID or simulator UDID |
| `platform` | `"android" \| "ios"` | Yes | Target platform |

**Result**

```json
{
  "success": true,
  "message": "Accessibility service upgraded",
  "status": { "status": "upgraded" }
}
```

For iOS, `status` is omitted and `message` is `"CtrlProxy iOS restarted"`.

---

### `ide/setKeyValue`

Writes a value into an Android app's SharedPreferences file via the accessibility service. <kbd>🤖 Android Only</kbd>

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `deviceId` | `string` | Yes | ADB device ID |
| `appId` | `string` | Yes | Application package name |
| `fileName` | `string` | Yes | SharedPreferences file name (without `.xml`) |
| `key` | `string` | Yes | Preference key |
| `value` | `string \| null` | Yes | Value to write; `null` removes the key |
| `type` | `"STRING" \| "INT" \| "LONG" \| "FLOAT" \| "BOOLEAN" \| "STRING_SET"` | Yes | Preference type |

**Result**

```json
{ "success": true }
```

---

### `ide/removeKeyValue`

Removes a single key from an Android app's SharedPreferences file. <kbd>🤖 Android Only</kbd>

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `deviceId` | `string` | Yes | ADB device ID |
| `appId` | `string` | Yes | Application package name |
| `fileName` | `string` | Yes | SharedPreferences file name |
| `key` | `string` | Yes | Preference key to remove |

**Result**

```json
{ "success": true }
```

---

### `ide/clearKeyValueFile`

Clears all keys from an Android app's SharedPreferences file. <kbd>🤖 Android Only</kbd>

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `deviceId` | `string` | Yes | ADB device ID |
| `appId` | `string` | Yes | Application package name |
| `fileName` | `string` | Yes | SharedPreferences file name |

**Result**

```json
{ "success": true }
```

---

## Input API

<kbd>🚧 Partially Implemented</kbd>

The daemon input API is the consumer-facing contract for IDE screen control and
other direct-input clients. These methods use the same newline-delimited JSON
socket protocol and response envelope as the rest of this page, but they are
purpose-built for coordinate, text, and button input instead of requiring
clients to construct ad hoc MCP `tools/call` payloads.

Use the `input/*` methods for direct consumer input from IDE plugins, CLI
clients, screen mirrors, and test recorders. Use `tools/call` as a fallback for
non-input MCP tools, advanced agent workflows that need an MCP-only tool, or
temporary access to behavior that does not yet have a direct daemon input
method.

IDE screen control must call these `input/*` socket methods. It must not bypass
this contract by invoking MCP tool payloads directly for tap, swipe, text, or
button input. See [Screen Streaming](../observe/screen-streaming.md) for the
future IDE mirroring/control surface that consumes this API.

### Common input fields

All input requests use `type: "mcp_request"` and a method name under `input/`.
The method-specific payload lives in `params`. `timeoutMs` remains a top-level
socket request field, matching the base protocol envelope.

| Field | Type | Required | Description |
|---|---|---|---|
| `platform` | `"android" \| "ios"` | Yes | Target device platform. |
| `deviceId` | `string` | No | ADB device ID or iOS simulator UDID. |

When `deviceId` is omitted, the daemon targets the device assigned to the
current socket session. If the socket session has no assigned device, the daemon
may target the only booted device matching `platform`. If more than one matching
device is available, the request fails and the caller must retry with an
explicit `deviceId`.

Input responses do not include a fresh observation or implicitly trigger one;
they return the action result only. Callers that need post-input state should
call `observe` through the MCP proxy or subscribe to the observation stream after
the input response returns.

### Implementation status

| Method | Android | iOS | Notes |
|---|---|---|---|
| `input/tap` | Supported | Supported | Absolute device-screen coordinates. |
| `input/swipe` | Supported | Supported | Absolute device-screen start/end coordinates. Use for drag gestures until `input/drag` has distinct semantics. |
| `input/drag` | Deferred | Deferred | Not a separate method in this contract. |
| `input/pressButton` | Supported | Supported with platform gaps | Device/navigation buttons aligned with MCP `pressButton`. Unsupported buttons fail instead of being ignored. |
| `input/typeText` | Supported | Supported | Sends committed text only; IME composition is deferred. |
| `input/key` | Deferred | Deferred | Use `input/pressButton` or `input/typeText`. |

All successful input responses use this result shape:

```json
{
  "action": "input/tap",
  "platform": "android",
  "deviceId": "emulator-5554",
  "success": true
}
```

Unsupported platforms or unsupported actions return `success: false` in the
socket response envelope:

```json
{
  "id": "tap-1",
  "type": "mcp_response",
  "success": false,
  "error": "Unsupported input action input/key on ios"
}
```

### Copy-paste raw socket examples

The examples below send one newline-delimited JSON request over the Unix socket.
They use the default socket path; replace `platform`, `deviceId`, and coordinates
with values from your device discovery flow.

```bash
export AUTOMOBILE_DAEMON_SOCKET_PATH="${AUTOMOBILE_DAEMON_SOCKET_PATH:-/tmp/auto-mobile-daemon-$(id -u).sock}"

printf '%s\n' '{"id":"tap-1","type":"mcp_request","method":"input/tap","params":{"platform":"android","deviceId":"emulator-5554","x":240,"y":640,"duration":50}}' \
  | nc -U "$AUTOMOBILE_DAEMON_SOCKET_PATH"

printf '%s\n' '{"id":"swipe-1","type":"mcp_request","method":"input/swipe","params":{"platform":"android","deviceId":"emulator-5554","startX":520,"startY":1700,"endX":520,"endY":500,"durationMs":350}}' \
  | nc -U "$AUTOMOBILE_DAEMON_SOCKET_PATH"

printf '%s\n' '{"id":"button-1","type":"mcp_request","method":"input/pressButton","params":{"platform":"android","deviceId":"emulator-5554","button":"back"}}' \
  | nc -U "$AUTOMOBILE_DAEMON_SOCKET_PATH"

printf '%s\n' '{"id":"type-1","type":"mcp_request","method":"input/typeText","params":{"platform":"android","deviceId":"emulator-5554","text":"hello from socket","submit":false}}' \
  | nc -U "$AUTOMOBILE_DAEMON_SOCKET_PATH"
```

Example success responses:

```json
{ "id": "tap-1", "type": "mcp_response", "success": true, "result": { "action": "input/tap", "platform": "android", "deviceId": "emulator-5554", "success": true, "coordinates": { "x": 240, "y": 640 } } }
{ "id": "swipe-1", "type": "mcp_response", "success": true, "result": { "action": "input/swipe", "platform": "android", "deviceId": "emulator-5554", "success": true, "start": { "x": 520, "y": 1700 }, "end": { "x": 520, "y": 500 }, "durationMs": 350 } }
{ "id": "button-1", "type": "mcp_response", "success": true, "result": { "action": "input/pressButton", "platform": "android", "deviceId": "emulator-5554", "success": true, "button": "back" } }
{ "id": "type-1", "type": "mcp_response", "success": true, "result": { "action": "input/typeText", "platform": "android", "deviceId": "emulator-5554", "success": true, "textLength": 17, "submitted": false } }
```

The socket returns exactly one response per request. If the request times out,
the envelope has `success: false`; treat that response as authoritative and
re-observe device state before assuming the input landed.

### `input/tap`

Taps an absolute device-screen coordinate. Coordinates are physical pixels in
the current device orientation.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `platform` | `"android" \| "ios"` | Yes | Target platform. |
| `deviceId` | `string` | No | Target device; see [Common input fields](#common-input-fields). |
| `x` | `number` | Yes | X coordinate in physical screen pixels. |
| `y` | `number` | Yes | Y coordinate in physical screen pixels. |
| `duration` | `number` | No | Tap duration in milliseconds. |

**Request**

```json
{
  "id": "tap-1",
  "type": "mcp_request",
  "method": "input/tap",
  "params": {
    "platform": "android",
    "deviceId": "emulator-5554",
    "x": 240,
    "y": 640,
    "duration": 50
  }
}
```

**Result**

```json
{
  "action": "input/tap",
  "platform": "android",
  "deviceId": "emulator-5554",
  "success": true,
  "coordinates": { "x": 240, "y": 640 }
}
```

### `input/swipe`

Swipes from one absolute device-screen coordinate to another. `input/drag` is
deferred until a distinct drag semantic is needed; clients should use
`input/swipe` for pointer drags that only need start/end coordinates and a
duration.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `platform` | `"android" \| "ios"` | Yes | Target platform. |
| `deviceId` | `string` | No | Target device; see [Common input fields](#common-input-fields). |
| `startX` | `number` | Yes | Start X coordinate in physical screen pixels. |
| `startY` | `number` | Yes | Start Y coordinate in physical screen pixels. |
| `endX` | `number` | Yes | End X coordinate in physical screen pixels. |
| `endY` | `number` | Yes | End Y coordinate in physical screen pixels. |
| `durationMs` | `number` | No | Gesture duration in milliseconds, from 1 to 60 000 inclusive. The daemon uses 300 when omitted. |

**Request**

```json
{
  "id": "swipe-1",
  "type": "mcp_request",
  "method": "input/swipe",
  "params": {
    "platform": "android",
    "startX": 520,
    "startY": 1700,
    "endX": 520,
    "endY": 500,
    "durationMs": 350
  }
}
```

**Result**

```json
{
  "action": "input/swipe",
  "platform": "android",
  "deviceId": "emulator-5554",
  "success": true,
  "start": { "x": 520, "y": 1700 },
  "end": { "x": 520, "y": 500 },
  "durationMs": 350
}
```

### `input/pressButton`

Presses a device or navigation button.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `platform` | `"android" \| "ios"` | Yes | Target platform. |
| `deviceId` | `string` | No | Target device; see [Common input fields](#common-input-fields). |
| `button` | `"back" \| "home" \| "app_switch" \| "volume_up" \| "volume_down" \| "power" \| "enter"` plus MCP aliases `"menu"` and `"recent"` | Yes | Button to press. Unsupported buttons fail with `success: false`. |

**Request**

```json
{
  "id": "button-1",
  "type": "mcp_request",
  "method": "input/pressButton",
  "params": {
    "platform": "android",
    "button": "back"
  }
}
```

**Result**

```json
{
  "action": "input/pressButton",
  "platform": "android",
  "deviceId": "emulator-5554",
  "success": true,
  "button": "back"
}
```

**Examples**

Examples for supported Android navigation and hardware actions:

```json
{ "method": "input/pressButton", "params": { "platform": "android", "button": "back" } }
{ "method": "input/pressButton", "params": { "platform": "android", "button": "home" } }
{ "method": "input/pressButton", "params": { "platform": "android", "button": "app_switch" } }
{ "method": "input/pressButton", "params": { "platform": "android", "button": "power" } }
{ "method": "input/pressButton", "params": { "platform": "android", "button": "volume_up" } }
{ "method": "input/pressButton", "params": { "platform": "android", "button": "volume_down" } }
```

`app_switch` is the socket API name for the app switcher and maps to the MCP
`recent` button implementation. The daemon also accepts the MCP alias `recent`.

`enter` is reserved by the socket contract but is not implemented by
`input/pressButton`; callers should use `input/typeText` for committed text and
wait for `input/key` for discrete key forwarding. `enter` currently returns a
clear unsupported error instead of being treated as an unknown field value.

iOS supports `home`, `back`, and `app_switch` through CtrlProxy navigation. On
physical iOS devices, `power`, `volume_up`, and `volume_down` route to the
hardware button endpoint. iOS simulators return clear unsupported errors for
hardware buttons, and all iOS targets return an unsupported error for `menu`
because iOS has no menu hardware button.

### `input/typeText`

Types text into the currently focused field. IME composition is out of scope for
this contract; clients should send the final committed string.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `platform` | `"android" \| "ios"` | Yes | Target platform. |
| `deviceId` | `string` | No | Target device; see [Common input fields](#common-input-fields). |
| `text` | `string` | Yes | Non-empty text to type. |
| `submit` | `boolean` | No | When true, press enter/return after typing if the platform supports it. |

**Request**

```json
{
  "id": "type-1",
  "type": "mcp_request",
  "method": "input/typeText",
  "params": {
    "platform": "ios",
    "deviceId": "A1B2C3D4-0000-0000-0000-000000000000",
    "text": "hello",
    "submit": false
  }
}
```

**Result**

```json
{
  "action": "input/typeText",
  "platform": "ios",
  "deviceId": "A1B2C3D4-0000-0000-0000-000000000000",
  "success": true,
  "textLength": 5,
  "submitted": false
}
```

### `input/key`

Discrete key input is deferred until the daemon has a platform-neutral key name
set and is tracked in [#3370](https://github.com/kaeawc/auto-mobile/issues/3370).
Until then, clients should use `input/pressButton` for supported device and
navigation buttons, and `input/typeText` for text.

Requests to `input/key` must fail until implemented:

```json
{
  "id": "key-1",
  "type": "mcp_response",
  "success": false,
  "error": "input/key is not implemented; use input/pressButton or input/typeText"
}
```

---

## MCP Proxy Endpoints

These are forwarded to the daemon's internal MCP server. The response wraps whatever the MCP server returns.

### `tools/list`

Lists all registered MCP tools. Equivalent to the MCP `tools/list` protocol message.

**Params:** none

**Result:** standard MCP `ListToolsResult`.

---

### `tools/call`

Calls a registered MCP tool by name.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | MCP tool name (e.g. `observe`, `tapOn`) |
| `arguments` | `object` | Yes | Tool-specific arguments |

**Result:** standard MCP `CallToolResult`.

#### Tool-specific timeout floors

Some `tools/call` operations routinely run longer than the 30 000 ms default. For
these, the daemon raises the effective timeout to a per-tool **floor** — the
request still uses `max(timeoutMs, floor)`, so a caller-supplied `timeoutMs` above
the floor is preserved, but a shorter one (or none) is lifted to the floor rather
than aborting work that is still in progress.

| Tool | Default floor | Override |
|---|---|---|
| `executePlan` | 600 000 ms | — |
| `startDevice` | 180 000 ms | — |
| `launchApp` | 90 000 ms | — |
| `openLink` | 90 000 ms | `AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS` (legacy alias: `AUTO_MOBILE_OPEN_LINK_MCP_TIMEOUT_MS`) |

`openLink`'s floor is configurable because a deeplink can launch the app and then
block on a backend round-trip (sign-in / token exchange). Set
`AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS` to a higher millisecond value on the daemon
process for deployments with even slower deeplinks; values at or below the 90 000 ms
default, or non-numeric values, are ignored.

> **Post-timeout semantics.** A request that exceeds its (possibly raised) timeout
> returns `MCP error -32001: Request timed out` to the caller. The underlying tool
> may still finish afterward; when it does, the daemon logs the late result at
> `WARN` noting it "completed after the caller's request already timed out" rather
> than emitting a contradictory `success=true`. Treat the `-32001` timeout as the
> authoritative outcome for that call and re-`observe` to confirm device state if
> needed.

---

### `resources/list`

Lists all registered MCP resources.

**Params:** none

**Result:** standard MCP `ListResourcesResult`.

---

### `resources/read`

Reads a single MCP resource by URI.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `uri` | `string` | Yes | Resource URI (e.g. `automobile:devices/booted`) |

**Result:** standard MCP `ReadResourceResult`.

---

### `resources/list-templates`

Lists available MCP resource templates.

**Params:** none

**Result:** standard MCP `ListResourceTemplatesResult`.

---

### `ide/getNavigationGraph`

Convenience wrapper that calls the `getNavigationGraph` MCP tool and returns its result directly. Accepts the same arguments as the MCP tool.

**Params:** same as the `getNavigationGraph` MCP tool (all optional).

**Result:** navigation graph tool result.

---

## Daemon Management Endpoints

These manage the device pool and session lifecycle. See [Daemon Overview](index.md) for pool architecture details.

### `daemon/availableDevices`

Returns current device pool statistics.

**Params:** none

**Result**

```json
{
  "availableDevices": 3,
  "totalDevices": 4,
  "assignedDevices": 1,
  "errorDevices": 0,
  "stats": {
    "total": 4,
    "idle": 3,
    "assigned": 1,
    "error": 0
  }
}
```

---

### `daemon/refreshDevices`

Re-discovers connected devices and updates the pool.

**Params:** none

**Result**

```json
{
  "addedDevices": 1,
  "totalDevices": 4,
  "availableDevices": 3,
  "stats": { "total": 4, "idle": 3, "assigned": 1, "error": 0 }
}
```

---

### `daemon/sessionInfo`

Returns metadata for an active session.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | `string` | Yes | Session ID to query |

**Result**

```json
{
  "sessionId": "abc-123",
  "assignedDevice": "emulator-5554",
  "platform": "android",
  "createdAt": 1718000000000,
  "lastUsedAt": 1718000010000,
  "expiresAt": 1718003600000,
  "cacheSize": 4096
}
```

Returns an error if the session does not exist.

---

### `daemon/releaseSession`

Releases a session and returns its device to the idle pool. Idempotent — safe to call even if the session was already released.

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | `string` | Yes | Session to release |

**Result**

```json
{
  "message": "Session abc-123 released",
  "device": "emulator-5554",
  "alreadyReleased": false
}
```

When the session was already released (or never existed):

```json
{
  "message": "Session abc-123 already released or never existed",
  "alreadyReleased": true
}
```
