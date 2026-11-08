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
- `postNotification` creates a notification for notification-flow tests. On a watchOS or
  Apple TV simulator, provide the app’s bundle ID as `appId` to deliver a push to that app.
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
call instead. `phoneCall` with `accept` or `hold` on a simulator therefore sends
nothing to the app and returns, without an error and whether or not the app embeds
the SDK or a `phoneNumber` is given:

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
(missing `phoneNumber`, no SDK, an SDK rejection, an unsupported device) is
returned as a tool error.

## Reaching a host server from the device

When an app or browser on an Android device must reach a server on your
machine at exactly `http://localhost:<port>` (an OAuth redirect URI, a local
mock backend), use `portReverse` instead of running `adb reverse` yourself:

- `ensure` with `ports: [{ devicePort, hostPort? }]` adds each mapping
  (`hostPort` defaults to `devicePort`). Calling it again is a no-op.
  With `reclaimStale: true`, a mapping left behind by a crashed session, a
  daemon restart or another tool is replaced instead of reported as a conflict,
  but only when your session holds the device, no running session owns the
  mapping, its host side is `tcp:<H>`, and nothing on your machine accepts a
  connection on port `H`. That mapping's result carries
  `reclaimed: { host, reason: "host_refused" }`. When adb talks to a server on
  another machine (`ANDROID_ADB_SERVER_ADDRESS` or `ADB_SERVER_SOCKET`), host
  ports cannot be checked, so nothing is reclaimed.
- `list` returns every reverse on the device; `owned: true` marks the ones
  your session created, `owner: "prototype"` marks one a shown or saved
  prototype's `via: "device"` request uses, and `hostListening` says whether a server on your
  machine accepts connections on each mapping's `tcp:` host port (absent when
  it could not be checked).
- `list` and `verify` give each port a `deviceListener`: `{ kind: "none" }`
  (nothing listens on the device port), `{ kind: "reverse" }` (the reverse
  itself), `{ kind: "process", uid, package? }` (an app or other process on the
  device holds the port; `package` is set when exactly one package has that
  uid) or `{ kind: "unsupported", detail }` (the device would not show its
  listening sockets).
- `verify` reports whether ports (default: all of yours) are mapped now. With
  `probe: true` it also connects to each mapped port from the device (about a
  second, all ports at once) and reports `reachable` (your host server accepted
  and kept the connection open), `unreachable` or `probe_unsupported`. Ports
  that are not mapped stay `missing` and are not probed. `unreachable` carries a
  `probeReason`: `closed` (the mapping exists but nothing is listening on the
  host port), `refused` (nothing is listening on the device port) or `timeout`
  (the device did not answer). `probe_unsupported` means the device shell has no
  usable connect command; `probeDetail` holds what it printed. A host server
  that closes idle connections within a second reads as `closed`.
  A TCP connect succeeds for any server, including the wrong one on a reused
  host port. To check the right service answers, pass
  `probe: { http: { path, expectStatus, hostHeader?, expectBodyContains?, timeoutMs? } }`:
  the device sends `GET <path>` through each mapping and reports `httpStatus`.
  A port is `reachable` when the status is in `expectStatus` (and the body
  contains `expectBodyContains`, when given); otherwise `unreachable` with
  `probeReason` `http_status` (another status), `http_body` (the text is
  missing), `no_http_response` (the connection ended, or something answered,
  without an HTTP response; `probeDetail` shows what came back), `refused` or
  `timeout`. `path` must start with `/` and contain no spaces; `hostHeader`
  defaults to `localhost:<devicePort>`; `timeoutMs` (1000-10000, default 2000)
  is rounded up to whole seconds. Responses over 256 KB are not read and report
  `timeout`.
- `remove` deletes mappings your session created. A port a prototype also uses
  is reported `released`: your session no longer owns it, and it stays on the
  device until the prototype is dismissed. Likewise `ensure` on a prototype's
  port to the same host port shares it (`present`) instead of conflicting.

AutoMobile owns the mappings it creates for your session. If one disappears
(an adb server restart, `adb reconnect`, `adb root`/`unroot`, an emulator
restart, or `adb reverse --remove` run outside AutoMobile), AutoMobile re-adds
it on its own once it sees the device's adb connection recover or on its
periodic check (every 30 s by default), and otherwise the next `ensure`, `list`
or `verify` call re-adds it. Either way, that next call lists it in `restored`; a mapping it
could not re-add is listed in `restoreFailures` and retried on the next call. Your mappings are removed when your session is
released or leaves the device. Mappings made without a session stay until the
device disconnects; AutoMobile stops tracking them then, and a device that stays
connected keeps them until you run `adb reverse --remove`.

Errors come back with `errorCode`:

| `errorCode`                       | Meaning and what to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port_reverse_conflict`           | The device port is already mapped by someone else or to another host port. Nothing changed; pick another port or remove the existing mapping. `conflicts` lists each port's `conflictKind` (also given at the top level when every port has the same one): `other_session` (another running session owns it), `prototype` (a prototype's request uses it, mapped to another host port), `external_live` (made outside AutoMobile and its host port accepts connections) or `external_unknown` (made outside AutoMobile and its host port was not shown to be live; retry with `reclaimStale: true` to replace it if it is stale). |
| `port_reverse_device_port_in_use` | A process on the device already listens on the device port, so the reverse cannot be added. The message names its uid and package; stop it or pick another device port.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `port_reverse_reclaim_failed`     | `reclaimStale` found a stale mapping but could not remove it, or it changed just before removal. That mapping was left as it was and this call\'s new mappings were rolled back; a stale mapping the same call already reclaimed stays removed. Call `list` to see the current mappings.                                                                                                                                                                                                                                                                                                                                          |
| `port_reverse_not_owned`          | `remove` named a port your session did not create. Nothing was removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `port_reverse_port_refused`       | A port is below 1024 or outside `AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS`, or `ports` was missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

On iOS the tool returns `status: "not_applicable"`: a simulator shares the
host's network, so `localhost:<port>` already reaches your machine.

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

The identity is read again once the snapshot is saved. If it changed while the
capture ran, the capture is refused with `fixture_invalidated` and nothing is
recorded. When `AUTOMOBILE_EMULATOR_ARGS` redirects the userdata image with
`-data`, the fixture tracks that image.

Every restore of a fixture checks those inputs first, settings-only restores
included. If any changed, the restore is refused, the device is left as it
was, and the fixture is removed. Its in-AVD snapshot is deleted then, or, if
that fails, the next time a snapshot is captured on that emulator:

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

A fixture persists across sessions. VM retention (`maxVmSnapshotsPerAvd`,
`maxVmArchiveSizeMb`) neither evicts it nor counts it. It is removed only when
it is invalidated, when you delete it, or when `deleteDevice` (or the session
broker) destroys its AVD.

### Deleting a snapshot

Delete any snapshot, fixture or not, by name:

```json
{
  "name": "deviceSnapshot",
  "arguments": { "action": "delete", "snapshotName": "signed-in", "platform": "android" }
}
```

Run it on the snapshot's own device, as for a restore: a snapshot of another
device or AVD is refused. The result has `deleted: true` once the snapshot and
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
