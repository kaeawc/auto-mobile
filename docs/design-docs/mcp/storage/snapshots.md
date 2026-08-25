# Device State Snapshots

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** `deviceSnapshot` MCP tool is fully implemented. VM snapshots (emulators), settings-only snapshots (all other Android devices), and iOS simulator app container backups are all supported. See the [Status Glossary](../../status-glossary.md) for chip definitions.
>
> **App data on Android:** The deprecated `adb backup` app-data path was removed
> in #5708. `adb backup` is deprecated since Android 12 (API 31), requires
> interactive on-device confirmation, and produced no `backup.ab` in practice on
> API 34. App data is now captured only by VM snapshots (emulators, which capture
> the entire emulator state); for targeted app-data inspection use the DataStore,
> shared-storage, `sqlQuery`, and preferences tools. **Physical Android devices
> and non-VM emulator snapshots no longer capture app data** — they capture device
> settings and foreground-app state only.

## Overview

The snapshot feature provides deterministic device state management for mobile testing. It supports Android device/emulator snapshots and iOS simulator app container backups to enable reproducible test environments and efficient parallel testing.

## Features

- **VM Snapshots for Emulators**: Instant snapshot/restore using Android emulator's built-in snapshot feature (captures full app data)
- **Settings-only Snapshots**: Portable device-settings snapshots for physical Android devices and non-VM emulator captures (no app data)
- **iOS App Container Backups**: Portable app-scoped snapshots for iOS simulators
- **Auto-generated Naming**: Automatic timestamp-based snapshot names with optional custom naming
- **Host-based Storage**: Snapshots stored in `~/.auto-mobile/snapshots/` for fast access and easy management

## MCP Tool

### deviceSnapshot

Capture or restore device snapshots.

**Parameters:**

- `action` (required): `"capture"` or `"restore"`
- `snapshotName` (capture: optional, restore: required): Name for the snapshot
- `includeAppData` (capture only): Include app data. Honored by VM snapshots (emulators) and iOS app-container backups. **Ignored on non-VM Android** (physical devices / `useVmSnapshot: false`), which is settings-only — the captured manifest records `includeAppData: false`.
- `includeSettings` (capture only): Include system settings (global/secure/system)
- `useVmSnapshot` (capture/restore): Use emulator VM snapshot if available (faster for emulators)
- `vmSnapshotTimeoutMs` (capture/restore): Timeout in milliseconds for emulator VM snapshot commands
- `strictBackupMode` (capture only, **iOS-only**): If true, fail the whole snapshot unless every requested bundle is backed up (all-or-nothing) — any bundle that is not-installed, container-less, or fails to copy rejects the capture with an `ActionableError` naming the uncovered bundles (issue #5711). No effect on Android now that the adb-backup path is gone.
- `appBundleIds` (capture only): iOS bundle IDs to include in app container backups
- `sessionUuid` (optional): Session UUID for multi-device targeting
- `device` (optional): Device label for multi-device control

**Capture response:**

```json
{
  "message": "Snapshot 'Pixel_5_2026-01-08_12-30-45' captured successfully",
  "snapshotName": "Pixel_5_2026-01-08_12-30-45",
  "snapshotType": "vm",
  "timestamp": "2026-01-08T12:30:45.123Z",
  "deviceId": "emulator-5554",
  "deviceName": "Pixel_5",
  "manifest": { ... },
  "evictedSnapshotNames": ["older-snapshot"]
}
```

**Restore response:**

```json
{
  "message": "Snapshot 'clean-state-before-login-test' restored successfully",
  "snapshotName": "clean-state-before-login-test",
  "snapshotType": "vm",
  "restoredAt": "2026-01-08T12:35:00.456Z",
  "deviceId": "emulator-5554",
  "deviceName": "Pixel_5"
}
```

**Examples:**

```javascript
// Capture with auto-generated name
await deviceSnapshot({ action: "capture" });

// Capture with custom name
await deviceSnapshot({
  action: "capture",
  snapshotName: "clean-state-before-login-test",
});

// Restore a snapshot
await deviceSnapshot({
  action: "restore",
  snapshotName: "clean-state-before-login-test",
});
```

## MCP Resources

### automobile:deviceSnapshots/archive

List archived device snapshots.

**Returns:**

```json
{
  "snapshots": [
    {
      "snapshotName": "Pixel_5_2026-01-08_12-30-45",
      "deviceId": "emulator-5554",
      "deviceName": "Pixel_5",
      "platform": "android",
      "snapshotType": "vm",
      "includeAppData": true,
      "includeSettings": true,
      "createdAt": "2026-01-08T12:30:45.123Z",
      "lastAccessedAt": "2026-01-08T12:30:45.123Z",
      "sizeBytes": 47448064,
      "sizeLabel": "45.23 MB"
    }
  ],
  "count": 1,
  "totalSizeBytes": 47448064,
  "maxArchiveSizeMb": 100
}
```

## Configuration

Device snapshot defaults can be read or updated via the Unix socket at `~/.auto-mobile/device-snapshot.sock`.

**Defaults:**

- `includeAppData`: `true`
- `includeSettings`: `true`
- `useVmSnapshot`: `true`
- `strictBackupMode`: `false` (iOS-only)
- `vmSnapshotTimeoutMs`: `30000`
- `maxArchiveSizeMb`: `100`

## Snapshot Types

The response `snapshotType` field reflects how the snapshot was taken. The type
union (`DeviceSnapshotType` in `src/models/DeviceSnapshot.ts`) is `vm` (emulator
VM snapshot), `adb` (non-VM Android settings-only snapshot), `app_data` (iOS
app-container copy), and `simctl` (reserved for a simulator-level type; not
currently emitted by the capture paths). The `adb` type is retained for backward
compatibility with existing archived snapshots; it no longer carries app data.

### VM Snapshots (Emulators Only)

**Pros:**

- Instant snapshot capture and restoration
- Complete system state including RAM
- No need to clear app data individually

**Cons:**

- Only works with Android emulators
- Requires emulator console access

**Technical Details:**

- Uses `adb emu avd snapshot save/load` commands
- Emulator replies with `OK` or `KO: <reason>` (missing `OK` is treated as failure)
- Commands time out after 30000ms by default (configurable via `vmSnapshotTimeoutMs`)
- Snapshots stored in emulator's AVD directory (typically `~/.android/avd/<avd>.avd/snapshots/`)
- Metadata stored in `~/.auto-mobile/snapshots/` for management

### Settings-only Snapshots (Non-VM Android)

Used for physical Android devices and for emulator captures with
`useVmSnapshot: false`. The `snapshotType` is `adb`.

**Pros:**

- Works with both emulators and physical devices
- Portable across device types
- Fast — no app-data transfer or user confirmation

**Cons:**

- Does **not** capture app data (see the note below)

**What Gets Captured:**

- System settings (global/secure/system via the CtrlProxy settings namespaces,
  with a `settings list` ADB fallback)
- Foreground app state

**What Gets Restored:**

- Restores system settings via the CtrlProxy `settings put` path (with a
  `settings put` ADB fallback)
- Relaunches the foreground app

> **App data is not captured or restored here.** The deprecated `adb backup` /
> `adb restore` path was removed in #5708 (deprecated since API 31, required
> interactive on-device confirmation, and produced no `backup.ab` on API 34). No
> `pm clear`, `adb backup`, or `adb restore` commands are issued. To snapshot app
> data on an emulator, use a VM snapshot; for targeted app-data inspection use the
> DataStore, shared-storage, `sqlQuery`, and preferences tools. Legacy archived
> snapshots that still carry `adb backup` metadata are restored as settings-only —
> the stale app-data metadata is ignored.

### iOS App Container Backups (Current)

**Pros:**

- Portable between dev machines
- Captures only the target app's container for focused reproduction

**Cons:**

- Does not include the keychain or other apps' state (captures the target app's container, plus global/secure/system settings when `includeSettings` is set)
- Requires explicit bundle IDs for the target app(s)

**Technical Details:**

- Uses `xcrun simctl get_app_container <udid> <bundleId> data`
- Captures `iosSettings` (global/secure/system) into the manifest when `includeSettings` is enabled (`captureIosSettings` in `src/utils/ios-cmdline-tools/iosSettings.ts`)
- Copies `Documents/`, `Library/`, and `tmp/` for each bundle ID
- Snapshot type is `app_data`
- Simulator-wide `simctl snapshot` is intentionally not used for portability
- Each requested bundle ID is validated up front (installed via `simctl listapps`, has a data container via `get_app_container … data`) and reported with a per-bundle status — `captured`, `skipped-no-container`, `not-installed`, or `failed` — in `appDataBackup.bundleStatuses` and at the top level of the capture tool result (`bundleStatuses`), rather than silently "succeeding"
- Capture with `includeAppData: true` but no usable `appBundleIds` (empty or all blank) is rejected with an `ActionableError` — pass explicit bundle IDs, or set `includeAppData: false` for a settings-only snapshot
- Capture with `includeAppData: true` where **0** of the requested bundles are actually backed up (every one not-installed, container-less, or failed) is rejected with an `ActionableError` naming the requested set and what failed/was skipped — this holds regardless of `strictBackupMode`, so an empty backup can no longer report "captured successfully" (issue #5710). A mixed set with at least one captured bundle still succeeds; settings-only captures (`includeAppData: false`) are unaffected

## Storage Location

Snapshot payloads are stored in `~/.auto-mobile/snapshots/` (settings-only Android snapshots), and metadata is tracked in SQLite at `~/.auto-mobile/auto-mobile.db`:

Android emulator settings-only snapshots are scoped by AVD name — unique
(avdmanager enforces one AVD per name) and stable across reboots, unlike the
port-based emulator serial — so the same snapshot name can be reused across
AVDs without a filesystem collision. Physical Android devices have no AVD name
and keep the unscoped path.

```text
~/.auto-mobile/snapshots/
├── android/
│   └── <avd-name>/             # e.g. Pixel_5
│       └── <snapshot-name>/
│           └── settings.json   # Device settings (settings-only snapshots)
└── <snapshot-name>/            # physical Android (no AVD name) — unscoped
    └── settings.json
```

VM snapshots themselves are stored in the emulator AVD directory and persist across emulator restarts. Automatic cleanup removes AutoMobile metadata and host snapshot payloads, but does not delete the emulator's VM snapshot.

iOS app container backups are stored per simulator device ID:

```text
~/.auto-mobile/snapshots/ios/
└── <device-udid>/
    └── <snapshot-name>/
        ├── metadata.json
        └── app-data/
            └── <bundle-id>/
                ├── Documents/
                ├── Library/
                └── tmp/
```

## Use Cases

### 1. Deterministic Testing

Eliminate state pollution between test runs by starting each test from an identical snapshot:

```javascript
// Setup: Capture clean state
await deviceSnapshot({ action: "capture", snapshotName: "clean-base-state" });

// Before each test
await deviceSnapshot({ action: "restore", snapshotName: "clean-base-state" });

// Run test...
```

### 2. Parallel Testing

Run multiple tests in parallel with each starting from the same snapshot:

```javascript
// Create base snapshot once
await deviceSnapshot({ action: "capture", snapshotName: "test-base" });

// In parallel test runners
await Promise.all([
  runTest1(() => deviceSnapshot({ action: "restore", snapshotName: "test-base" })),
  runTest2(() => deviceSnapshot({ action: "restore", snapshotName: "test-base" })),
  runTest3(() => deviceSnapshot({ action: "restore", snapshotName: "test-base" })),
]);
```

### 3. Debugging

Save device state before a failure occurs, then restore and debug:

```javascript
try {
  // Test code that might fail
  await runComplexTest();
} catch (error) {
  // Capture state at failure point
  await deviceSnapshot({ action: "capture", snapshotName: "failure-state" });
  throw error;
}

// Later, restore and debug
await deviceSnapshot({ action: "restore", snapshotName: "failure-state" });
```

### 4. Regression Detection

Compare snapshots across app versions to detect unintended changes:

```javascript
// Version 1.0
await deviceSnapshot({ action: "capture", snapshotName: "v1.0-baseline" });

// Version 1.1
await deviceSnapshot({ action: "capture", snapshotName: "v1.1-baseline" });

// Compare manifests programmatically
const v1 = await loadManifest("v1.0-baseline");
const v2 = await loadManifest("v1.1-baseline");
```

## App Data on Android

App data on Android is captured **only** by VM snapshots (emulators), which
snapshot the entire emulator state as a superset of app data. The previous
`adb backup` / `adb restore` app-data path for non-VM Android was removed in
#5708:

- `adb backup` is deprecated since Android 12 (API 31) and requires interactive
  on-device confirmation, so it cannot be automated.
- In practice it produced no `backup.ab` on API 34 while still reporting success.
- It is redundant with VM snapshots and with the targeted app-data tools
  (DataStore, shared-storage resources, `sqlQuery`, preferences).

**Consequence:** physical Android devices, and emulator captures taken with
`useVmSnapshot: false`, no longer snapshot app data — they capture device
settings and foreground-app state only. To capture app data, take a VM snapshot
on an emulator; to inspect a specific app's data, use the targeted tools above.

The iOS app-container backups (`snapshotType: "app_data"`) are unaffected and
still honor `strictBackupMode`.

## Limitations

- **Android + iOS Simulator Only**: iOS snapshots are app container backups for simulators
- **App Data on Android**: Captured only by VM snapshots (emulators); non-VM Android snapshots are settings-only (#5708)
- **VM Snapshots**: Only available for emulators, not physical devices
- **Storage Space**: Snapshots can be large (especially VM snapshots), manage storage accordingly
- **iOS Simulator Snapshot**: `simctl snapshot` is intentionally not used; app container backups are the current choice

## Performance

- **VM Snapshot Capture**: ~2-5 seconds
- **VM Snapshot Restore**: ~3-8 seconds (includes emulator stabilization)
- **Settings-only Snapshot Capture/Restore**: ~1-3 seconds (settings only, no app data)
- **iOS App Container Backup**: Varies with app data size

## Best Practices

1. **Use VM Snapshots for Emulators**: Significantly faster, and the only way to snapshot app data on Android
2. **Manage Archive Size**: Automatic cleanup enforces `maxArchiveSizeMb` (adjust via the device snapshot socket config)
3. **Descriptive Names**: Use meaningful snapshot names for easier management
4. **Base Snapshots**: Create a "golden" base snapshot and restore from it
5. **Device Matching**: Ensure snapshots are restored to compatible devices (same platform)

## Troubleshooting

### Snapshot Capture Fails

- Verify device is connected and responsive
- For VM snapshots, ensure emulator console is accessible
- If VM snapshot commands time out, increase `vmSnapshotTimeoutMs` or restart the emulator
- If the emulator reports an unknown command, update the emulator to a version that supports snapshots
- Check available disk space in `~/.auto-mobile/snapshots/`

### Snapshot Restore Fails

- Verify snapshot exists using the `automobile:deviceSnapshots/archive` resource
- Check platform compatibility (snapshot vs device)
- For VM snapshots, ensure emulator is running
- If the emulator reports device offline, reconnect or restart the emulator

### Snapshot Too Large

- Use a settings-only (non-VM) snapshot instead of a VM snapshot when app data is not needed
- Adjust `maxArchiveSizeMb` to control archive size
