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

`user_files` on an iOS Simulator stages files through the managed Files fixture
app `dev.jasonpearson.automobile.FilesFixture`. Writes go only to
`Documents/automobile/<namespace>`, and reset deletes only that namespace. If the
fixture app is not installed, the call returns guidance on installing it. Staging a
file does not guarantee it shows up in a document picker. Physical iOS devices and
listing or reading user files on iOS are not supported.

On Android, `putAppFile` accepts an optional `userId` (a non-negative integer) to
target a work or secondary profile. When you omit it, AutoMobile uses the only user
the app is installed for. With several candidates it prefers the foreground app's
user, then the current user. If it is still ambiguous, the error lists the candidate
IDs and asks you to pass `userId`. Private `documents`/`cache`/`tmp` containers
require a debuggable app. `externalFiles` writes to the app's external files
directory for the chosen user. On API 30+, writing to other apps' `Android/data`
directories may be denied by the platform. See [File containers](../tools.md) for
semantics.

To list or read files, use the resource
`automobile:devices/{deviceId}/storage-domains/app_containers/{appId}/{container}{?userId}`,
appending `/{path}` before the query to read a file. For example:
`automobile:devices/emulator-5554/storage-domains/app_containers/com.example.app/documents/settings.json?userId=10`.
Returned file URIs include the resolved user (`?userId=N`) where it matters.
iOS URIs have no user query.

## Locale and device state

- `changeLocalization` sets language, region, time zone, and formatting for a
  device. Set the locale before launching the app.
- `setDeviceState` configures supported system state such as biometric
  enrollment, an Android lock-screen PIN, password, or pattern (`screenLock`)
  that the session clears on release, or Android power constraints (`power`:
  battery, battery saver, Doze, standby buckets, Data Saver, thermal status)
  that the session restores on release.
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

An Android VM restore can return a new `deviceSessionUuid`. Your own `sessionUuid`
stays valid. If you subscribed to the old device-session UUID, you receive
`device_session_ended` with `successorSessionUuid` and
`reason: "superseded-by-restore"`, followed by `device_session_started`; subscribe
again with the new UUID. Settings-only restores omit this field.

### Fixtures

Capture with `fixture: true` to keep an Android emulator VM snapshot as a
reusable fixture, for example a device state that took a long setup to reach.
The snapshot then records what it depends on: the AVD, its system image and
hardware config, the emulator version, and its userdata image. A fixture must
be an emulator VM snapshot: on a physical device, an iOS simulator, or with
`useVmSnapshot: false`, the capture is refused with
`fixture_requires_vm_snapshot` and nothing is saved.

Every restore of a fixture checks those inputs first. If any changed, the
restore is refused and the device is left as it was:

```json
{
  "success": false,
  "code": "fixture_invalidated",
  "snapshotName": "signed-in",
  "retryable": false,
  "reasons": ["userdata-wiped"]
}
```

| Reason                     | What changed                                                   |
| -------------------------- | -------------------------------------------------------------- |
| `system-image-changed`     | The AVD's system image package or its installed revision       |
| `avd-config-changed`       | The AVD's hardware config                                      |
| `emulator-version-changed` | The installed emulator                                         |
| `userdata-wiped`           | The userdata image was re-created, for example by `-wipe-data` |
| `avd-changed`              | The AVD itself                                                 |

Capture the fixture again with `fixture: true` to replace it. Pass
`fixture: true` on restore to require a fixture: a snapshot captured without it
is refused with `snapshot_not_a_fixture`, and `useVmSnapshot: false` with
`fixture_requires_vm_snapshot`.

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
first. `maxVmArchiveSizeMb` is a per-AVD byte ceiling and is unlimited by default because a
single VM snapshot is routinely gigabytes. `maxArchiveSizeMb` does not apply to `vm`
records; it continues to govern only archive-store `app_data`, `adb`, and
`simctl` records.

`maxVmSnapshotsPerAvd`, `maxVmArchiveSizeMb`, and `maxArchiveSizeMb` cannot be set
through a CLI flag, environment variable, or MCP tool; the defaults apply.

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
