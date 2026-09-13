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

## Locale and device state

- `changeLocalization` sets language, region, time zone, and formatting for a
  device. Set the locale before launching the app.
- `setDeviceState` configures supported system state such as biometric
  enrollment.
- `biometricAuth` simulates a match or failure on supported emulators and iOS
  simulators.
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
