# Unix Socket API

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

The AutoMobile daemon exposes a Unix socket for IDE plugins and CLI clients to communicate with the daemon without going through MCP. See [Daemon Overview](index.md) for architecture context.

## Socket Path

```
/tmp/auto-mobile-daemon-<uid>.sock
```

The path can be overridden via the `AUTOMOBILE_DAEMON_SOCKET_PATH` or `AUTO_MOBILE_DAEMON_SOCKET_PATH` environment variables.

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
| `timeoutMs` | `number` | No | Per-request timeout in milliseconds (default: 30 000). Long-running `tools/call` requests may be raised to a tool-specific minimum timeout by the daemon. `openLink` can be configured with `AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS` (legacy alias: `AUTO_MOBILE_OPEN_LINK_MCP_TIMEOUT_MS`), defaulting to 30 000 ms. |

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
