# Test prep tools

Prepare a repeatable device and app state before running a flow. These tools
are useful for fixtures, localization, permissions, and system state.

## App files

Use `putAppFile` to write text, base64, or a host file into an app container:

```json
{
  "name": "putAppFile",
  "arguments": {
    "platform": "android",
    "target": {
      "domain": "app_containers",
      "appId": "com.example.app",
      "container": "documents"
    },
    "files": [
      {
        "destinationPath": "fixtures/settings.json",
        "contentText": "{\"enabled\":true}"
      }
    ]
  }
}
```

`putAppFile` never terminates the app. After a successful `app_containers` write,
`result.warning` appears when the target app is known to be running (on Android,
in the written user profile): it may not see the change until it re-reads the file
or is relaunched. The warning is omitted when running state is unknown or the
app is not running, and for `user_files` and `media_library` writes.

`user_files` also supports bounded iOS Simulator staging through the managed
Files fixture app `dev.jasonpearson.automobile.FilesFixture` (not yet shipped in
this repo). It resolves the installed app's data container at runtime and writes
only `Documents/automobile/<namespace>`; reset deletes only that namespace.
Missing fixture installation returns actionable guidance. Host staging and
picker visibility are separate effects; visibility is unavailable unless a
verifier observes the exact destination. Physical iOS and iOS user-files
list/read remain unsupported or unexposed. Validation here uses fakes; the
historical iOS 17.5 picker experiment is documented in the
[accepted design](../decisions/ios-user-files-provider.md).

On Android, `putAppFile` accepts optional `userId` (a non-negative safe integer).
An explicit ID selects that profile without discovery. Omission checks package
installation for every user: use the sole installed user; with several candidates,
prefer the user of the foreground app when it is the requested package, then the
current user if installed among the candidates. Otherwise, ambiguity lists the
candidate IDs and asks for `userId`; no installation names the app/device, and
failed discovery asks for an explicit ID. Batches resolve once. Private
`documents`/`cache`/`tmp` containers use `run-as` and require a debuggable app.
`externalFiles` uses `/sdcard/Android/data/<appId>/files` for user 0 and
`/storage/emulated/<userId>/Android/data/<appId>/files` for nonzero users.
Shared-storage domains keep their existing resolution.

The canonical list resource is
`automobile:devices/{deviceId}/storage-domains/app_containers/{appId}/{container}{?userId}`;
its existing `automobile:devices/{deviceId}/apps/{appId}/files/{container}{?userId}`
alias remains supported until device verification permits retirement;
append `/{path}` before the query to read a file. For example:
`automobile:devices/emulator-5554/storage-domains/app_containers/com.example.app/documents/settings.json?userId=10`.
Both accept the same optional `?userId=N`; omission auto-resolves on Android.
Returned put and list file URIs pin the resolved Android user. Explicit IDs
always round-trip, including `?userId=0`, without extra discovery. Auto-resolved
nonzero users always include `?userId=N`; auto-resolved user 0 includes
`?userId=0` only when the app is installed for several users. A sole user-0
installation keeps the existing query-free URI. The same rule applies to
`externalFiles`; iOS URIs have no user query.

**Unverified:** `run-as --user` API support has no captured fixture. Unsupported
option/usage errors identify this uncertainty (unverified which API level),
and advise omitting `userId` only for a primary-user installation or using a
debuggable build via an adb-user-0 session. **Unverified, from Android
scoped-storage documentation:** on API 30+, plain shell read/list access to other
apps' `Android/data` directories is not guaranteed and push may be denied;
the existing shell/push mechanism is retained. See
[File containers](../tools.md) for semantics and the Android documentation source.

## Locale and device state

- `changeLocalization` sets language, region, time zone, and formatting for a
  device. Set the locale before launching the app.
- `setDeviceState` configures supported system state such as biometric
  enrollment.
- `biometricAuth` simulates a match or failure on supported emulators and iOS
  simulators, and every result in apps that embed the AutoMobile SDK.
- `wakeAndUnlock` wakes an Android device and unlocks it with an optional PIN.
- `postNotification` creates a notification for notification-flow tests.
- `clipboard` sets, reads, pastes, or clears clipboard content.

For a clean app start, use `launchApp` with `clearAppData: true` where the
platform supports it. Use `observe` after preparation to confirm the expected
state before continuing.

## Device snapshots

Enable `deviceSnapshot` for the current connection, then capture a known-good
state before a destructive flow:

```json
{
  "name": "setToolEnabled",
  "arguments": { "toolName": "deviceSnapshot", "enabled": true }
}
```

```json
{
  "name": "deviceSnapshot",
  "arguments": {
    "action": "capture",
    "snapshotName": "signed-in",
    "platform": "android",
    "includeAppData": true,
    "includeSettings": true
  }
}
```

Android emulators can restore full VM snapshots. iOS simulators back up the
specified app containers, so an iOS capture that includes app data must list
the bundle IDs:

```json
{
  "name": "deviceSnapshot",
  "arguments": {
    "action": "capture",
    "snapshotName": "signed-in",
    "platform": "ios",
    "appBundleIds": ["com.example.app"],
    "includeAppData": true,
    "includeSettings": true
  }
}
```

For an iOS settings-only capture, set `includeAppData` to `false`. Physical
Android devices restore settings only. Restore with `action: "restore"` and the
same `snapshotName`.

An Android VM restore in daemon mode returns a new `deviceSessionUuid` when
the device has a live registry epoch. The owning tool `sessionUuid` survives.
The old device-session UUID is superseded by the restore: subscribers receive
`device_session_ended` with `successorSessionUuid` and
`reason: "superseded-by-restore"`, followed by `device_session_started` for the
new epoch. Subscribe again with the returned UUID. You can also discover it
from `daemon/listDeviceSessions` or the device description's
`runtime.deviceSessionUuid`. Direct mode, settings-only restores, and devices
without a live epoch omit this field. A definitive pre-load rejection preserves
the epoch; a VM load followed by readiness failure still retires it.

### Archive size, eviction, and reclaim

The archive resource `automobile:deviceSnapshots/archive` reports what the
snapshot archive costs and what still needs cleaning up:

| Field                  | Meaning                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totalSizeBytes`       | Sum of every record whose size is known.                                                                                                                |
| `unsizedCount`         | Records whose payload could not be measured. They are **not** in `totalSizeBytes`, so a non-zero count means the archive is larger than the total says. |
| `pendingReclaimCount`  | Records whose in-AVD VM snapshot still needs deleting because its emulator was offline.                                                                 |
| `orphanedAvdSnapshots` | In-AVD snapshot directories with no record behind them.                                                                                                 |
| `maxVmSnapshotsPerAvd` | Maximum VM snapshots retained for each Android AVD (default 3).                                                                                         |
| `maxVmArchiveSizeMb`   | Optional additional per-AVD byte ceiling for VM snapshots; `null` means unlimited.                                                                      |
| `maxArchiveSizeMb`     | The byte budget for non-`vm` (`app_data`, `adb`, `simctl`) archive records (default 100 MB).                                                            |

An Android emulator VM snapshot does not live in the archive store — the
emulator writes it inside the AVD, at
`~/.android/avd/<avd>.avd/snapshots/<name>/` (`ram.bin`, `textures.bin`,
`snapshot.pb`, ...), which is routinely a couple of gigabytes. That directory is
what a `vm` record's size measures. VM snapshots are retained per AVD by
`maxVmSnapshotsPerAvd` (default 3), evicting least-recently-accessed records
first. Operators that also need a VM byte ceiling can opt into the per-AVD
`maxVmArchiveSizeMb` setting; it is unlimited by default because a single VM
snapshot is routinely gigabytes. `maxArchiveSizeMb` does not apply to `vm`
records; it continues to govern only archive-store `app_data`, `adb`, and
`simctl` records.

`maxVmSnapshotsPerAvd`, `maxVmArchiveSizeMb`, and `maxArchiveSizeMb` are
`DeviceSnapshotConfig` fields, but no CLI flag, environment variable, or MCP
tool sets them today. They take effect through the compiled-in defaults in
`src/features/snapshot/DeviceSnapshotConfig.ts` or the daemon's private
device-snapshot-config Unix-socket `updateConfig` protocol in
`src/daemon/deviceSnapshotSocketServer.ts`; its only known consumer is the
desktop app's Kotlin `DeviceSnapshotSocketClient`, which does not yet pass
through either VM-specific field. Exposing them through that client or a
first-class CLI/MCP surface is follow-up work, not part of this change.

Evicting a `vm` record deletes the in-AVD snapshot through the emulator console
(`adb -s <serial> emu avd snapshot del <name>`). When that emulator is not
running there is nothing to issue the delete to, so the record is **kept** and
flagged `pendingReclaim` rather than dropped — dropping it would lose the only
reference to gigabytes still on disk. The next capture on that AVD sweeps the
flagged records and finishes the job.

#### Cleaning up orphaned in-AVD snapshots

`orphanedAvdSnapshots` lists in-AVD snapshot directories no record accounts for.
AutoMobile never deletes them automatically: an orphan may predate AutoMobile or
be a snapshot someone made by hand. The emulator's own `default_boot` quick-boot
state is excluded from the report entirely.

Each entry reports `avdName`, `snapshotName`, `sizeBytes` and `directoryPath`.
**Use `directoryPath`** for anything that touches the filesystem: it is the
directory the scan actually measured. `ANDROID_AVD_HOME` (and an `<avd>.ini`
registry file redirecting to a relocated AVD) move an AVD off the conventional
`~/.android/avd/<avd>.avd` path, so that path is not reliably where the bytes
are.

To remove one yourself, with the AVD's emulator running:

```bash
adb -s <serial> emu avd snapshot del <snapshot-name>
```

With the emulator stopped, delete the reported directory directly:

```bash
rm -rf "<directoryPath>"
```

Check what is there first with `du -sh "<directoryPath>"`, or list every in-AVD
snapshot of one AVD with `du -sh "$(dirname "<directoryPath>")"/*`.
