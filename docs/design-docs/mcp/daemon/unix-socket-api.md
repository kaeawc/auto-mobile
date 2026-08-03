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
  "timeoutMs": 30000,
  "clientVersion": "1.2.3",
  "clientBuildId": "sha256:...",
  "clientEntryScript": "/absolute/path/to/client-entry.js"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Caller-assigned ID echoed back in the response |
| `type` | `"mcp_request" \| "daemon_request"` | Yes | Request category |
| `method` | `string` | Yes | Endpoint name (e.g. `ide/ping`, `daemon/availableDevices`) |
| `params` | `object` | Yes | Method-specific parameters; pass `{}` when none are needed |
| `timeoutMs` | `number` | No | Per-request timeout in milliseconds (default: 30 000). Long-running `tools/call` requests may be raised to a tool-specific minimum timeout by the daemon (see [Tool-specific timeout floors](#tool-specific-timeout-floors)). |
| `clientVersion` | `string` | No | Client package/release version. Supply it to opt into version mismatch detection; clients that omit every handshake field are treated as legacy and bypass the handshake. |
| `clientBuildId` | `string` | No | Content hash of the client entry script. TypeScript clients should supply this together with `clientEntryScript` for build-identity detection. |
| `clientEntryScript` | `string` | No | Absolute path to the client entry script. Supply it with `clientBuildId`; Kotlin and Swift clients use `clientVersion` only. |

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

#### Coordinate space (canonical pixels)

Coordinates are **canonical physical pixels** in the current device orientation —
the same space the observation stream publishes element `bounds` and screen
dimensions in when a message carries `coordinateSpace: "px"` (issue
[#4549](https://github.com/kaeawc/auto-mobile/issues/4549)). A client maps a tap
from the frame it is rendering straight into these `input/*` coordinates with no
unit conversion of its own.

The daemon performs any runner-specific conversion internally: the iOS XCUITest
runner addresses the screen in **logical points**, so for iOS the daemon divides
each incoming pixel coordinate by the runner-reported `nativeScale` before
dispatch. That divide is an **exact fractional quotient** — it is NOT rounded —
because XCUITest accepts fractional (`Double`) points and quantizing would discard
sub-point precision. (Round-half-away-from-zero applies only on the publish side, where
points are converted to integer physical pixels; the input divide is its exact
inverse, so the round-trip carries only that single publish-side quantization.)
Android runners already take physical pixels, so nothing is converted. If the iOS
runner supplied no scale metadata (a pre-#4548 runner, so its frames were never
published as `coordinateSpace: "px"`), the daemon leaves the coordinates
untouched — the legacy point-space fallback, in which the client was already
working in points. See
[Client Frame Snapshot: coordinate space](client-frame-snapshot.md#coordinate-space-canonical-pixels).

### Implementation status

| Method | Android | iOS | Notes |
|---|---|---|---|
| `input/tap` | Supported | Supported | Absolute device-screen coordinates. |
| `input/swipe` | Supported | Supported | Absolute device-screen start/end coordinates. Use for drag gestures until `input/drag` has distinct semantics. |
| `input/drag` | Deferred | Deferred | Not a separate method in this contract. |
| `input/pressButton` | Supported | Supported with platform gaps | Device/navigation buttons aligned with MCP `pressButton`. Unsupported buttons fail instead of being ignored. |
| `input/typeText` | Supported | Supported | Sends committed text only; IME composition is deferred. Non-destructive `mode: "append"` is supported on both platforms. |
| `input/key` | Supported | Unsupported | Discrete non-text key presses. Modifiers are deferred. |

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
  "id": "key-ios-1",
  "type": "mcp_response",
  "success": false,
  "error": "input/key is unsupported on ios; CtrlProxy does not expose discrete key events"
}
```

### Copy-paste raw socket examples

The examples below send one newline-delimited JSON request over the Unix socket.
They use the default socket path; replace `platform`, `deviceId`, and coordinates
with values from your device discovery flow. The short `nc -w` timeout keeps
these one-shot examples from staying attached to the daemon's long-lived socket
after the response frame is printed. A screen-control client must replace
`android-generation-42` with the opaque `frameContext` from its paired screenshot
and hierarchy; it is illustrative and cannot be reused for another frame.
These `frameContext` examples require a runner that publishes the field; the
default `0.0.49` CtrlProxy artifacts are legacy and cannot supply one.

```bash
export AUTOMOBILE_DAEMON_SOCKET_PATH="${AUTOMOBILE_DAEMON_SOCKET_PATH:-/tmp/auto-mobile-daemon-$(id -u).sock}"

printf '%s\n' '{"id":"tap-1","type":"mcp_request","method":"input/tap","params":{"platform":"android","deviceId":"emulator-5554","x":240,"y":640,"duration":50,"frameContext":"android-generation-42"}}' \
  | nc -U -w 2 "$AUTOMOBILE_DAEMON_SOCKET_PATH"

printf '%s\n' '{"id":"swipe-1","type":"mcp_request","method":"input/swipe","params":{"platform":"android","deviceId":"emulator-5554","startX":520,"startY":1700,"endX":520,"endY":500,"durationMs":350,"frameContext":"android-generation-42"}}' \
  | nc -U -w 2 "$AUTOMOBILE_DAEMON_SOCKET_PATH"

printf '%s\n' '{"id":"button-1","type":"mcp_request","method":"input/pressButton","params":{"platform":"android","deviceId":"emulator-5554","button":"back","frameContext":"android-generation-42"}}' \
  | nc -U -w 2 "$AUTOMOBILE_DAEMON_SOCKET_PATH"

printf '%s\n' '{"id":"type-1","type":"mcp_request","method":"input/typeText","params":{"platform":"android","deviceId":"emulator-5554","text":"hello from socket","submit":false,"frameContext":"android-generation-42"}}' \
  | nc -U -w 2 "$AUTOMOBILE_DAEMON_SOCKET_PATH"

printf '%s\n' '{"id":"key-1","type":"mcp_request","method":"input/key","params":{"platform":"android","deviceId":"emulator-5554","key":"enter","frameContext":"android-generation-42"}}' \
  | nc -U -w 2 "$AUTOMOBILE_DAEMON_SOCKET_PATH"
```

Example success responses:

```json
{ "id": "tap-1", "type": "mcp_response", "success": true, "result": { "action": "input/tap", "platform": "android", "deviceId": "emulator-5554", "success": true, "coordinates": { "x": 240, "y": 640 } } }
{ "id": "swipe-1", "type": "mcp_response", "success": true, "result": { "action": "input/swipe", "platform": "android", "deviceId": "emulator-5554", "success": true, "start": { "x": 520, "y": 1700 }, "end": { "x": 520, "y": 500 }, "durationMs": 350 } }
{ "id": "button-1", "type": "mcp_response", "success": true, "result": { "action": "input/pressButton", "platform": "android", "deviceId": "emulator-5554", "success": true, "button": "back" } }
{ "id": "type-1", "type": "mcp_response", "success": true, "result": { "action": "input/typeText", "platform": "android", "deviceId": "emulator-5554", "success": true, "textLength": 17, "submitted": false } }
{ "id": "key-1", "type": "mcp_response", "success": true, "result": { "action": "input/key", "platform": "android", "deviceId": "emulator-5554", "success": true, "key": "enter" } }
```

The socket returns exactly one response per request. If the request times out,
the envelope has `success: false`; treat that response as authoritative and
re-observe device state before assuming the input landed.

### Frame-context safety

Every `input/*` request may include an optional `frameContext` string copied from both the
`screenshot_update` and `hierarchy_update` that describe the exact rendered frame. Omit it to
retain the legacy behavior byte-for-byte.

When supplied, the daemon compares it with the newest device-authored observation context and
rejects a mismatch before executing the action with an actionable `observe a fresh frame before
retrying` error. Current Android and iOS CtrlProxy runners also validate context-bearing gestures
at the device boundary. iOS derives the opaque value from the captured hierarchy before and after
a screenshot; if the UI changes during capture, the screenshot intentionally has no context and a
client must not invent one. This protects same-size navigation as well as rotations and resolution
changes.

The device-boundary guarantee applies to `input/tap`, `input/swipe`, `input/pressButton`,
`input/key`, and `input/typeText`. The runner rejects a stale frame context at the device boundary
before dispatching each of these, so a UI transition before a replacement hierarchy reaches the
daemon cannot execute a context-bearing request against the wrong frame. The Android button, key,
and append-mode `typeText` paths were completed in
[#4618](https://github.com/kaeawc/auto-mobile/issues/4618).

The value is opaque, device-specific, and must only be echoed unchanged. It is not a timestamp,
not portable across devices or runner restarts, and a client must fail closed when the screenshot
and hierarchy contexts are absent or unequal.

| Field | Type | Required | Description |
|---|---|---|---|
| `frameContext` | `string` | No | Opaque context from the paired screenshot and hierarchy. Screen-control clients echo it on every `input/*` request; generic callers without a rendered frame omit it. |

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
    "duration": 50,
    "frameContext": "android-generation-42"
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
    "durationMs": 350,
    "frameContext": "android-generation-42"
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
| `button` | `"back" \| "home" \| "app_switch" \| "volume_up" \| "volume_down" \| "power"` plus MCP aliases `"menu"` and `"recent"` | Yes | Button to press. Unsupported buttons fail with `success: false`. |

**Request**

```json
{
  "id": "button-1",
  "type": "mcp_request",
  "method": "input/pressButton",
  "params": {
    "platform": "android",
    "deviceId": "emulator-5554",
    "button": "back",
    "frameContext": "android-generation-42"
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
{ "method": "input/pressButton", "params": { "platform": "android", "deviceId": "emulator-5554", "button": "back", "frameContext": "android-generation-42" } }
{ "method": "input/pressButton", "params": { "platform": "android", "deviceId": "emulator-5554", "button": "home", "frameContext": "android-generation-42" } }
{ "method": "input/pressButton", "params": { "platform": "android", "deviceId": "emulator-5554", "button": "app_switch", "frameContext": "android-generation-42" } }
{ "method": "input/pressButton", "params": { "platform": "android", "deviceId": "emulator-5554", "button": "power", "frameContext": "android-generation-42" } }
{ "method": "input/pressButton", "params": { "platform": "android", "deviceId": "emulator-5554", "button": "volume_up", "frameContext": "android-generation-42" } }
{ "method": "input/pressButton", "params": { "platform": "android", "deviceId": "emulator-5554", "button": "volume_down", "frameContext": "android-generation-42" } }
```

`app_switch` is the socket API name for the app switcher and maps to the MCP
`recent` button implementation. The daemon also accepts the MCP alias `recent`.

`enter` is not a supported `input/pressButton` value. Callers should use
`input/key` for a discrete Enter press or `input/typeText` for committed text.

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
| `mode` | `"append"` | No | Append to the focused field instead of replacing its contents. Android uses real key events; iOS uses CtrlProxy's focused-field insert primitive. `"append"` is the only accepted value; any other value fails validation. |

**Replace vs. append.** On Android, the default path sets the focused field's
contents via `ACTION_SET_TEXT`, which **replaces** whatever is there — right for
"make this field say X" automation, destructive for a client mirroring a keyboard
one keystroke at a time (typing `abc` as three requests would leave the field
saying `c`). `mode: "append"` is the non-destructive alternative: it never clears or
uses the replace path. Android types through real key events; iOS dispatches to
CtrlProxy's focused-field insert primitive. Interactive
keyboard-forwarding clients MUST use it; see
[screen-control-mapping.md](./screen-control-mapping.md) for the full client
policy.

Append's semantics and limits:

- **iOS.** Append dispatches to CtrlProxy's focused-field insert primitive, which
  calls XCUITest `typeText` at the current caret without clearing or resolving a
  resource id.
- **Android printable ASCII only** (`U+0020`–`U+007E`). Any other character fails with
  `append cannot type "<char>" with Android key events`, and nothing is typed —
  a partial append would leave a prefix of the text in the field.
- **Uppercase and shifted symbols need Android 12 (API 31)**, where
  `input keycombination` can hold SHIFT. On older devices those characters fail
  with the same actionable error; lowercase, digits and unshifted punctuation
  work on every supported API level.
- **Clients may query before requesting append mode.** `daemon/capabilities` returns
  `input/typeText.mode:append` when this daemon understands the optional parameter.
  A daemon predating the query answers `Unsupported daemon method: daemon/capabilities`;
  that leaves append support unknown. Clients may send the non-destructive append request and must
  translate only the exact `input/typeText unsupported params: mode` response into an actionable
  update/restart error; they must never fall back to destructive replacement. The query remains
  subject to the normal socket version and build-identity handshake; clients must surface a mismatch
  error rather than treating it as unknown support.

**Android is best-effort, character-by-character — retry the remainder, not the whole
string.** Android append types one key event per character in order, so it is atomic only
for a **single character**: a one-character append either lands or reports failure
with nothing typed. A **multi-character** append is best-effort — if a definitive
ADB rejection occurs partway, a leading prefix of `text` has already been typed
into the field. Its failed socket envelope includes `charsSent`, the number of
leading characters confirmed as sent; retry only `text.slice(charsSent)`, not the
whole string. For example, if `"ab"` fails after confirmed delivery of `"a"`, the
response has `"charsSent": 1` and the client retries `"b"`, avoiding `"aab"`.
`charsSent: 0` means retry the full text; a full-length value means all text landed
and only a later part of the operation (such as submit) failed. The field is
omitted for non-append failures.

**Timeouts are ambiguous.** If the ADB child times out while issuing a key event,
Android may have accepted that current character before the host kills the child.
The failed response therefore omits `charsSent`, even when earlier characters were
confirmed, because retrying a suffix at that boundary could duplicate the timed-out
character. Re-observe the field before deciding how to recover, including when
the request contained only one character. Sending one character per request makes
definitive failure recovery simple, and is what the reference desktop client does,
but it does not make a timed-out key event atomic.

**Partial append failure response**

```json
{
  "id": "type-3",
  "type": "mcp_response",
  "success": false,
  "error": "append key event failed: adb rejected KEYCODE_B",
  "charsSent": 1
}
```

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
    "submit": false,
    "frameContext": "android-generation-42"
  }
}
```

**Request (append mode — one keystroke from an interactive client)**

```json
{
  "id": "type-2",
  "type": "mcp_request",
  "method": "input/typeText",
  "params": {
    "platform": "ios",
    "deviceId": "A1B2C3D4-0000-0000-0000-000000000000",
    "text": "a",
    "mode": "append",
    "frameContext": "android-generation-42"
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

Presses one discrete, non-text key. Use `input/typeText` for printable text and
`input/pressButton` for device/navigation buttons such as back, home, app switch,
power, and volume.

Modifiers are not supported in the first version. Requests that include
`modifiers` fail validation instead of silently ignoring them.

Supported key names:

| Key | Android mapping | iOS |
|---|---|---|
| `enter` | `KEYCODE_ENTER` | Unsupported |
| `tab` | `KEYCODE_TAB` | Unsupported |
| `escape` | `KEYCODE_ESCAPE` | Unsupported |
| `backspace` | `KEYCODE_DEL` | Unsupported |
| `delete` | `KEYCODE_FORWARD_DEL` | Unsupported |
| `arrow_up` | `KEYCODE_DPAD_UP` | Unsupported |
| `arrow_down` | `KEYCODE_DPAD_DOWN` | Unsupported |
| `arrow_left` | `KEYCODE_DPAD_LEFT` | Unsupported |
| `arrow_right` | `KEYCODE_DPAD_RIGHT` | Unsupported |

**Params**

| Field | Type | Required | Description |
|---|---|---|---|
| `platform` | `"android" \| "ios"` | Yes | Target platform. |
| `deviceId` | `string` | No | Target device; see [Common input fields](#common-input-fields). |
| `key` | One of the supported key names above | Yes | Platform-neutral key name. |

**Request**

```json
{
  "id": "key-1",
  "type": "mcp_request",
  "method": "input/key",
  "params": {
    "platform": "android",
    "deviceId": "emulator-5554",
    "key": "enter",
    "frameContext": "android-generation-42"
  }
}
```

**Result**

```json
{
  "action": "input/key",
  "platform": "android",
  "deviceId": "emulator-5554",
  "success": true,
  "key": "enter"
}
```

Unsupported keys fail with an actionable validation error:

```json
{
  "id": "key-2",
  "type": "mcp_response",
  "success": false,
  "error": "input/key key must be one of: enter, tab, escape, backspace, delete, arrow_up, arrow_down, arrow_left, arrow_right"
}
```

iOS currently returns an explicit unsupported-platform error because CtrlProxy
does not expose discrete key events:

```json
{
  "id": "key-1",
  "type": "mcp_response",
  "success": false,
  "error": "input/key is unsupported on ios; CtrlProxy does not expose discrete key events"
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

### `daemon/capabilities`

Returns additive socket capabilities that a client may inspect before sending an optional newer
parameter. It is available during daemon startup and remains subject to the normal socket version
and build-identity handshake. An older daemon that predates this endpoint returns its normal
unsupported-method error, which leaves append support unknown. Clients may send the non-destructive
append request and translate only its exact unsupported-parameter response. A version or build-
identity mismatch is a handshake error, not unknown support.

**Params:** none

**Result**

```json
{
  "capabilities": ["input/typeText.mode:append"]
}
```

`input/typeText.mode:append` means the daemon accepts `mode: "append"` for Android text input.
The list is intentionally extensible; clients must ignore capability strings they do not recognize.

---

### `daemon/availableDevices`

Returns current device-pool statistics, its startup-fixed recovery policy, and
recovery eligibility for each pooled device.

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
  },
  "recoveryPolicy": { "onLoss": true, "maxAttempts": 2 },
  "devices": [{
    "deviceId": "emulator-5554",
    "platform": "android",
    "recoveryEligibility": { "eligible": true, "action": "restart" }
  }]
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
