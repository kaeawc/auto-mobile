# Resources

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** All resources listed here are implemented. See the [Status Glossary](../status-glossary.md) for chip definitions.

AutoMobile exposes resources through the Model Context Protocol for AI agents to access.


MCP Resources provide read-only access to:

- Navigation graph data
- Test execution history
- Performance metrics
- Device information

## Available Resources

> This page documents the primary resources. It is **not** an exhaustive list of
> every registered resource — the server also registers observation, device
> images, test runs, video recording, device snapshots, databases, failures,
> storage, app files, feature flags, and network resources (see the
> `register*Resources()` calls in `src/server/index.ts`).

### Navigation Graph

**URI**: `automobile:navigation/graph`

Returns the current navigation graph showing:

- Known screens and their IDs
- Screen transitions and triggers
- UI elements that cause navigation
- Per-node/edge **provenance** — which build, device, and session reached each
  screen and transition (nav (app,build) Phase 2, [#4985](https://github.com/kaeawc/auto-mobile/issues/4985))

The graph is an **app-union**: a node or edge is present if any recorded build of
the app reached it, and each node/edge carries the union of the observations that
reached it. Consumers use provenance to weight rendering — the desktop navigation
pane draws screens/transitions reached in the currently-active context at 100%
opacity and everything else (another build/device, or historical) at 50%. A
record whose `deviceId` is the `"legacy"` sentinel is **unclassified** (e.g. iOS
events that carry no build context yet, deferred
[#4991](https://github.com/kaeawc/auto-mobile/issues/4991)) and is treated as
active/opaque rather than faded.

Each node's and edge's `provenance` is an **optional** array (omitted when the
summary is produced without a provenance source, e.g. fakes) of records:

- `buildKey` — the build identity: `{ packageId, versionCode, contentHash }`
- `deviceId` — the device that observed the mutation; `"legacy"` for rows
  backfilled from pre-provenance graphs or written before a build context existed
- `sessionUuid` — the owning agent-session UUID; `"legacy"` when unknown
- `lastSeen` — epoch milliseconds of the most recent observation for this
  `(buildKey, deviceId, sessionUuid)` tuple

Records are unique per `(buildKey, deviceId, sessionUuid)` and ordered
recency-first (newest `lastSeen`).

**Provenance shape** (illustrative node/edge fragment):

```json
{
  "provenance": [
    {
      "buildKey": {
        "packageId": "com.example.app",
        "versionCode": 42,
        "contentHash": "a1b2c3"
      },
      "deviceId": "emulator-5554",
      "sessionUuid": "3f9c1e70-0e2a-4a1b-9d1a-1f2e3d4c5b6a",
      "lastSeen": 1735776000000
    }
  ]
}
```

See [Navigation Graph](nav/index.md) for details.

### Navigation Apps

**URI**: `automobile:navigation/apps`

Lists the apps that have a **persisted** navigation graph, so an agent (or the
desktop's offline app picker) can choose an app to browse. This resource is
**device-independent** — it reads persisted data only and requires no connected
device. An app appears only when it has at least one recorded screen; an empty
database returns an empty list rather than an error.

Each entry provides:

- `appId` — the application package id (e.g. `com.example.app`)
- `displayName` — human-readable name when known; currently always `null`
  because the persisted schema has no display-name column
- `lastUpdated` — ISO-8601 timestamp of the app record's `updated_at`

Entries are ordered newest-first by the app record's `updated_at`.

**Response shape**:

```json
{
  "apps": [
    {
      "appId": "com.example.app",
      "displayName": null,
      "lastUpdated": "2026-01-02T00:00:00.000Z"
    }
  ]
}
```

> **`lastUpdated` caveat**: this field reflects the app record's
> `navigation_apps.updated_at`, which is bumped on the main navigation-recording
> paths but not by every graph mutation (e.g. `promoteSuggestion`,
> `updateNodeScreenshot`, `recordBackStack`). It can therefore lag those changes,
> and the `updated_at` ordering can too — do not treat it as the exact time of
> the most recent graph mutation. Tracked by
> [#4931](https://github.com/kaeawc/auto-mobile/issues/4931).

### Booted Devices

**URI**: `automobile:devices/booted`

Returns booted device inventory across Android and iOS, including:

- Total, per-platform, virtual, and physical device counts
- `observationComplete` plus a per-platform completion/error result, so an
  empty device list is only treated as durable absence after discovery completed
- Optional daemon pool status (idle/assigned/error) when the daemon is active
- Per-device pool assignment (status + session UUID) when available
- Stable device identity, transient connection identity, lifecycle state,
  runtime, form factor, readiness, and automation capability status

**URI Template**: `automobile:devices/booted/{platform}`

This resource supersedes the device data that the `listDevices` tool used to return. `listDevices` still exists as an MCP tool, but now returns **resource guidance** — a message pointing callers at these resource URIs — rather than device data (see `listDevicesHandler` in `src/server/deviceTools.ts`). The separate `daemon_available_devices` tool was removed.

### Device Images

**URI**: `automobile:devices/images`

Returns startable Android AVDs and iOS simulators plus a normalized
`provisioningCatalog`. The catalog lists available runtimes, device types,
Android system images, and Android device profiles where the installed platform
tools expose them. `catalogComplete` and per-platform `catalogObservations`
show whether the catalog can safely be used for provisioning decisions.

**URI Template**: `automobile:devices/images/{platform}`

### Session Observations

Session-scoped observation resources take the `sessionId` returned by
`startDevice` as their `{sessionUuid}` segment. They resolve that active session
to its assigned device and reject released or rebound sessions rather than
accepting a second device selector.

**URI Template**: `automobile:observation/session/{sessionUuid}/latest`

Returns the cached observation for the active session. Call `observe` first to
populate it.

**URI Template**: `automobile:observation/session/{sessionUuid}/latest/screenshot`

Returns the cached screenshot from that observation when available.

**URI Template**: `automobile:device-session/{sessionUuid}/screenshot`

Captures and returns a fresh PNG for the active session. A fresh request queues
behind an in-flight screenshot for the same device, then takes its own tracked
capture so session cleanup can cancel it safely.

### Installed Apps

**URI**: `automobile:apps`

Returns installed apps for booted devices. `deviceId` is required. Supports query parameters for filtering:

- `platform` (`android` or `ios`)
- `search` (case-insensitive partial match on package name or display name when available)
- `type` (`user` or `system`)
- `profile` (Android user ID, e.g. `0` or `10`)
- `deviceId` (booted device ID, required)

Example URIs:

- `automobile:apps?deviceId=emulator-5554&platform=android&search=slack&type=user`
- `automobile:apps?deviceId=YOUR_IOS_DEVICE_ID&platform=ios&search=calendar`

Clients can subscribe to specific `automobile:apps?deviceId=...` URIs for change notifications and re-read filtered URIs after updates.

### App Container Files

**URI Template**: `automobile:devices/{deviceId}/apps/{appId}/files/{container}`

Lists files in a logical app container without requiring callers to know Android or iOS container paths. Supported logical containers are:

- `documents`
- `library`
- `cache`
- `tmp`
- `externalFiles` where the platform supports it

List responses include each entry's relative `path`, `name`, `resourceUri`, `isDirectory` marker, byte size for files when available, and `lastModified` timestamp when the platform can report one. Host absolute app-container paths are intentionally omitted.

Example list request:

```json
{
  "method": "resources/read",
  "params": {
    "uri": "automobile:devices/emulator-5554/apps/com.example.app/files/documents"
  }
}
```

**URI Template**: `automobile:devices/{deviceId}/apps/{appId}/files/{container}/{path}`

Reads a single file from an app container. Nested paths and filenames containing spaces are encoded as URI path segments. Binary content is returned as an MCP `blob` so it can be round-tripped losslessly.
UTF-8 text files are returned as text with `text/plain; charset=utf-8` so clients do not need Android or iOS specific decoding logic.

iOS simulator examples:

- `automobile:devices/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/apps/com.example.app/files/documents/fixtures/welcome.png`
- `automobile:devices/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/apps/com.example.app/files/cache/responses/home.json`
- `automobile:devices/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE/apps/com.example.app/files/tmp/session/output.bin`

Example read request:

```json
{
  "method": "resources/read",
  "params": {
    "uri": "automobile:devices/emulator-5554/apps/com.example.app/files/documents/fixtures/welcome%20image.png"
  }
}
```

### Test Timing History

**URI**: `
automobile:test-timings`

Returns historical test execution data:

- Test class and method names
- Average execution duration
- Success/failure rates
- Device information
- Supports query parameters for filtering and sorting (e.g., lookbackDays, limit, minSamples, orderBy, sessionUuid).

See [Daemon](daemon/index.md) for test timing aggregation.

### Performance Results

**URI**: `
automobile:performance-results`

Returns recent UI performance audit results:

- Scroll framerate measurements
- Frame drop counts
- Render time statistics

### Localization Settings

**URI**: `automobile:devices/{deviceId}/localization`

Returns current localization settings for a device:

- Locale tag
- Time zone
- Text direction
- Time format
- Calendar system

## Using Resources

AI agents can request resources via MCP:

```json
{
  "method": "resources/read",
  "params": {
    "uri": "automobile:navigation/graph"
  }
}
```

The agent receives structured data that it can analyze and use to inform decisions.

## Implementation

See [MCP Server](index.md) for technical implementation details of resource providers.
