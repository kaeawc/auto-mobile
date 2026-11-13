# Test prep tools

Prepare a repeatable device and app state, such as fixtures, locale,
permissions, and system state, before running a flow.

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

`putAppFile` never terminates the app. After an `app_containers` write,
`result.warning` says the app may not see the change until it re-reads the file
or relaunches. It appears only when AutoMobile knows the app is running (on
Android, in the written user profile), and never for other domains.

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
IDs and asks you to pass `userId`.

Private `documents`/`cache`/`tmp` containers require a debuggable app.
`externalFiles` writes to the app's external files directory for the chosen user.
On API 30+, the platform may deny writes to other apps' `Android/data`
directories. See [File containers](../tools.md) for semantics.

To list files, read the resource
`automobile:devices/{deviceId}/storage-domains/app_containers/{appId}/{container}{?userId}`.
To read a file, append `/{path}` before the query, for example:
`automobile:devices/emulator-5554/storage-domains/app_containers/com.example.app/documents/settings.json?userId=10`.
Returned file URIs include the resolved user (`?userId=N`) where it matters.
iOS URIs have no user query.

## Locale and device state

- `changeLocalization` sets language, region, time zone, and formatting for a
  device. Set the locale before launching the app.
- `setDeviceState` configures supported system state:
  - biometric enrollment;
  - an Android lock-screen PIN, password, or pattern (`screenLock`), which the
    session clears on release;
  - Android power constraints (`power`: battery, battery saver, Doze, standby
    buckets, Data Saver, thermal status), which the session restores on release;
  - a camera poster (`cameraPoster`); see [Camera posters](#camera-posters).
- `biometricAuth` simulates a match or failure on supported emulators and iOS
  simulators, and every result in apps that embed the AutoMobile SDK.
- `wakeAndUnlock` wakes an Android device and unlocks it with an optional PIN.
- `postNotification` creates a notification for notification-flow tests. On a watchOS or
  Apple TV simulator, provide the app’s bundle ID as `appId` to deliver a push to that app.
  On iOS a single notification shows no app name, so `systemTray` can match it by
  `appId` only when it was posted with `postNotification`; otherwise omit `appId`.
- `clipboard` sets, reads, pastes, or clears clipboard content.

## Phone calls and SMS

`phoneCall` and `sendSms` are off by default; enable them before use.

| Device              | `phoneCall`                                       | `sendSms`                                 |
| ------------------- | ------------------------------------------------- | ----------------------------------------- |
| Android emulator    | All actions                                       | Supported                                 |
| Android physical    | Not supported                                     | Not supported                             |
| iOS Simulator + SDK | `call`, `cancel`, `busy`; `accept`/`hold` partial | SMS-style notification from the app's SDK |
| iOS physical        | Not supported                                     | Not supported                             |

On iOS the app under test must embed the AutoMobile iOS SDK; without it `sendSms`
and `phoneCall` `call`, `cancel` and `busy` fail with an error asking for the SDK.

The iOS Simulator cannot answer or hold a CallKit call: its call service ends the
call instead. On a simulator, `phoneCall` with `accept` or `hold` sends nothing to
the app. It returns this result without an error, with or without the SDK or a
`phoneNumber`:

```json
{
  "success": false,
  "supported": "partial",
  "reason": "ios_simulator_callkit_limit",
  "action": "accept",
  "message": "The iOS Simulator cannot accept or hold a CallKit call: ..."
}
```

Check `supported` and `reason` rather than treating this as a failure, and drive
the in-call state with `call`, `cancel` and `busy` instead. Every other failure
(missing `phoneNumber`, no SDK, an SDK rejection, an unsupported device) returns a
tool error.

## Reaching a host server from the device

Use `portReverse` when an app on an Android device must reach a server on your
machine at `http://localhost:<port>`. See
[Reaching a host server from the device](port-reverse.md) for its actions,
probes, and error codes.

## Camera posters

A camera poster puts an image or QR code in front of the camera. Physical iOS and
Android devices, and Apple platforms other than iOS, do not support camera posters.

`setDeviceState` `cameraPoster` accepts `mode: "image"` with a host PNG/JPG/JPEG
`path`, `mode: "qr"` with `text`, or `mode: "clear"`.

- Android emulators update the virtual-scene poster live (`surface: "wall"` or
  `"table"`).
- On iOS Simulator, the call records the poster for each app's next `launchApp`.
  It returns `method: "ios_simulator_dyld_injection"`, `path` when set, and
  `relaunchRequired: true`. Relaunch running apps; iOS ignores `surface`. After
  clearing, use `launchApp` with `coldBoot: true` to remove the poster from a
  running app.

`startDevice` accepts mutually exclusive `cameraPosterPath` or
`cameraPosterQr: { text }`. Android requires a stopped emulator; iOS Simulator also
accepts posters when already running.

On iOS, `launchApp` applies a registered poster with a cold launch and reports
`cameraPosterApplied: true`. Apple system apps (`com.apple.*`) launch normally
without the poster; the result reports `cameraPosterApplied: false` with a note in
`message`.

An iOS poster lasts until one of these happens:

- you clear it;
- `killDevice` kills the simulator;
- the session that holds the simulator is released or switches device;
- the daemon restarts.

A later session on the same simulator starts without a poster.

Setting an iOS poster needs Xcode. AutoMobile builds the injection library from the
packaged source on first use, for Intel and Apple silicon simulators. A missing
Xcode or library fails `startDevice` or `setDeviceState` and records nothing,
rather than failing the later `launchApp`. To skip the build, set
`AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB` to a prebuilt library.

## Clean start

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

AutoMobile reads the identity again once the snapshot is saved. If it changed
while the capture ran, AutoMobile refuses the capture with `fixture_invalidated`
and records nothing. When `AUTOMOBILE_EMULATOR_ARGS` redirects the userdata image with
`-data`, the fixture tracks that image.

Every restore of a fixture checks those inputs first, settings-only restores
included. If any changed, AutoMobile refuses the restore, leaves the device as it
was, and removes the fixture. It deletes the in-AVD snapshot then, or, if that
fails, at the next capture on that emulator:

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
`fixture: true` on restore to require a fixture:

| Restore of                     | Refused with                   |
| ------------------------------ | ------------------------------ |
| A snapshot captured without it | `snapshot_not_a_fixture`       |
| `useVmSnapshot: false`         | `fixture_requires_vm_snapshot` |

A fixture persists across sessions. VM retention (`maxVmSnapshotsPerAvd`,
`maxVmArchiveSizeMb`) neither evicts it nor counts it. It goes away only when it
is invalidated, when you delete it, or when `deleteDevice` destroys its AVD.

### Deleting a snapshot

Delete any snapshot, fixture or not, by name:

```json
{
  "name": "deviceSnapshot",
  "arguments": { "action": "delete", "snapshotName": "signed-in", "platform": "android" }
}
```

Run it on the snapshot's own device, as for a restore; AutoMobile refuses a
snapshot of another device or AVD. The result has `deleted: true` once the snapshot and
its data are gone. A VM snapshot whose in-AVD payload cannot be deleted now
returns `deleted: false` with `pendingReclaim: true`. Delete it again, or
capture any snapshot on that emulator, to finish it.

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

An Android emulator VM snapshot lives inside the AVD at
`~/.android/avd/<avd>.avd/snapshots/<name>/`, not in the archive store. A `vm`
record's size measures that directory, often a couple of gigabytes.

AutoMobile keeps up to `maxVmSnapshotsPerAvd` VM snapshots per AVD and evicts the
least recently accessed first. `maxArchiveSizeMb` does not apply to `vm` records.
You cannot set `maxVmSnapshotsPerAvd`, `maxVmArchiveSizeMb`, or `maxArchiveSizeMb`
through a CLI flag, environment variable, or MCP tool; the defaults apply.

Evicting a `vm` record deletes the in-AVD snapshot through the emulator console
(`adb -s <serial> emu avd snapshot del <name>`). When that emulator is not running,
AutoMobile **keeps** the record and flags it `pendingReclaim`. The next capture on
that AVD deletes the flagged snapshots.

#### Cleaning up orphaned in-AVD snapshots

`orphanedAvdSnapshots` skips the emulator's `default_boot` quick-boot state.
AutoMobile never deletes orphans automatically, since one may be a snapshot
someone made by hand.

Each entry reports `avdName`, `snapshotName`, `sizeBytes` and `directoryPath`.
**Use `directoryPath`** for anything that touches the filesystem: it is the
directory the scan measured. Setting `ANDROID_AVD_HOME`, or an `<avd>.ini` file
pointing elsewhere, moves an AVD off the usual `~/.android/avd/<avd>.avd` path.

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
