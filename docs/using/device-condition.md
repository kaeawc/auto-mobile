# Device condition fixtures

`setDeviceState` can put an Android device into a fault or root state, or set an iOS Simulator's status bar, privacy decisions or location, for a test, then restore it. Send a `deviceCondition` object as the call's only field; it cannot be combined with other `setDeviceState` fields.

```json
{
  "deviceCondition": {
    "faults": { "revokePermission": { "package": "com.example.app", "permission": "CAMERA" } }
  }
}
```

## Enabling it

`deviceCondition` is behind the `device-condition` feature flag, which is off by default. While it is off, every `deviceCondition` call fails with:

```text
deviceCondition is behind the 'device-condition' feature flag, which is disabled. Enable it with `auto-mobile --daemon set-feature-flag device-condition true` (or the IDE plugin's feature flag settings), then retry the call.
```

Turn it on from a shell with:

```bash
auto-mobile --daemon set-feature-flag device-condition true
```

or in the AutoMobile IDE plugin under **Settings > AutoMobile > Feature Flags**. The flag applies to the whole host, not one session, and stays set across daemon restarts. Pass `false` to turn it off again.

## Exporting key attestation

On Android, call `setDeviceState` with `{ "deviceCondition": { "exportAttestation": true } }` to export a temporary key's public certificate chain for a test backend. Send this alone, without conditions, reset or a lease; no session is required. The temporary key is deleted before the response is sent. If the image cannot generate attestation, the call fails; use an image supporting key attestation. If the installed automation service predates this action (it requires CtrlProxy 0.0.90 or newer), the call fails with an error naming that version; install CtrlProxy 0.0.90 or newer.

The `attestation` result contains `certificateChainBase64` (base64 DER, leaf first and root last), `rootCertificateBase64`, and `fields`: numeric `attestationSecurityLevel` and `keymasterSecurityLevel`, `deviceLocked`, `verifiedBootState`, and `attestationApplicationId` (raw base64, package names, decimal version strings and base64 signing-certificate digests). Missing optional fields are `null`. These are the certificate's reported fields, not a passing-integrity verdict or signature validation. The application ID describes the automation service that generated the key, not your app. Use the exported root only in your test backend's trust configuration; your backend still validates the app's own attestation chain and policy.

## Conditions

Set a condition by passing its value. Pass `"unset"` to clear it, or `{ "reset": true }` to restore everything applied on the device.

| Field                                 | What it does                                                                                                                                                                                                                                                                          | Restored on reset                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `rootState: "rooted-detectable"`      | Makes root-detection checks trip (non-Play emulator image with a writable `/system`)                                                                                                                                                                                                  | Yes                                                                    |
| `faults.battery`                      | `unplug`, `low` (15%) or `full`                                                                                                                                                                                                                                                       | Yes                                                                    |
| `faults.lowPower`                     | Battery saver on                                                                                                                                                                                                                                                                      | Yes, to its prior value                                                |
| `faults.doze`                         | Forces deep Doze                                                                                                                                                                                                                                                                      | Yes                                                                    |
| `faults.thermal`                      | `throttling` or `critical` thermal status                                                                                                                                                                                                                                             | Yes                                                                    |
| `faults.dontKeepActivities`           | Developer option "Don't keep activities" on                                                                                                                                                                                                                                           | Yes, to its prior value                                                |
| `faults.memoryPressure: "on"`         | Holds more than `MemAvailable` (up to 16384 MiB) to exhaust swap and trigger lmkd to kill background apps; unsupported if no kill follows. Uses a local build or `AUTOMOBILE_LMK_PRESSURE_DIR`, otherwise downloads the checksum-verified binary for the device ABI from the release. | Yes, stops the payload and removes its files; killed apps stay stopped |
| `faults.storage`                      | `low` (about 128 MiB free) or `full` (about 8 MiB free)                                                                                                                                                                                                                               | Yes                                                                    |
| `faults.readOnlyFilesystem: "on"`     | Makes shared storage `/sdcard` read-only for every app; writes fail with "Read-only file system" (EROFS). Rootable emulators only                                                                                                                                                     | Yes                                                                    |
| `faults.corruptAppFile`               | Damages one file in a debuggable app's data directory                                                                                                                                                                                                                                 | Yes, from a saved copy                                                 |
| `faults.revokePermission`             | Revokes one runtime permission                                                                                                                                                                                                                                                        | Yes, re-granted                                                        |
| `faults.lockScreen`                   | Sets an AutoMobile test PIN or removes the PIN; removal invalidates lock-screen-bound keys. `unset` restores no lock screen                                                                                                                                                           | Yes, restores no lock screen                                           |
| `faults.biometricEnrollment`          | Emulators only: `add` enrolls one more fingerprint, which invalidates keys created with `setInvalidatedByBiometricEnrollment(true)`; `none` removes every fingerprint                                                                                                                 | Yes, restores no lock screen and no fingerprints                       |
| `faults.disablePackage`               | Disables an app for the current user                                                                                                                                                                                                                                                  | Yes, re-enabled                                                        |
| `faults.clockSkew`                    | Moves the device clock `offsetSeconds` from real time, with automatic time off                                                                                                                                                                                                        | Yes, to real time and the original automatic-time setting              |
| `faults.killApp`                      | Ends an app's process once (`background` or `forceStop`)                                                                                                                                                                                                                              | No: one-shot                                                           |
| `faults.trimMemory`                   | Sends a running app one `onTrimMemory` level; foreground needs `RUNNING_*` (Android refuses `HIDDEN`, `BACKGROUND`, `MODERATE`, `COMPLETE`)                                                                                                                                           | No: one-shot                                                           |
| `faults.clearPackageData`             | Clears an app's data                                                                                                                                                                                                                                                                  | No: one-shot, cannot be undone                                         |
| `vehicle.motion`, `vehicle.nightMode` | Automotive vehicle state; see [Android Automotive OS](android-automotive.md)                                                                                                                                                                                                          | Yes                                                                    |
| `statusBar`                           | iOS Simulator: overrides `time`, `batteryLevel`, `batteryState`, `cellularBars`, `wifiBars`, `dataNetwork` and `operatorName` (at least one)                                                                                                                                          | Yes, every override cleared                                            |
| `privacy`                             | iOS Simulator: grants or revokes one privacy service for an app (`{ appId, service, action }`)                                                                                                                                                                                        | Yes, to the app's earlier decision                                     |
| `location`                            | iOS Simulator: simulates the device location (`{ latitude, longitude }`)                                                                                                                                                                                                              | Yes, simulated location cleared                                        |

`rootState` needs a non-Play image booted with `-writable-system`, which keeps `/system` writable. Without it, apply returns `unsupported` with guidance to boot with `-writable-system`. After the daemon stops with the fixture applied, the next `unset` or `reset` on the device removes the planted files and restores SELinux.

`faults.biometricEnrollment` drives the emulator's Settings enrollment screens and touches its virtual sensor with `adb emu finger touch`, so it needs an emulator whose console accepts `finger` commands and whose system language is English. It is refused on a physical device. Settings only enrolls a fingerprint behind a lock screen, so the first `add` needs a device with no lock screen and sets the AutoMobile test PIN (`1234`); each later `add` enrolls another fingerprint, up to five. Android deletes fingerprints with the lock-screen credential, so `none`, `unset` and reset all clear the test PIN, which leaves no lock screen and no fingerprints. Lock-screen-bound keys are deleted with it. Do not combine it with `faults.lockScreen`.

To invalidate an enrollment-bound key: `add` once, have the app create its key, then `add` again.

`faults.memoryPressure` ends by itself 30 minutes after the payload becomes ready, even if the daemon dies.

A condition the device cannot apply comes back `unsupported` with a `detail` reason, and the call reports `success: false`. The call's other changes still apply.

## iOS Simulator

On an iOS Simulator, `statusBar`, `privacy` and `location` apply and restore like the Android conditions. They are not available on Android or a physical iOS device yet, and return `unsupported` there.

`privacy.service` is one of `calendar`, `contacts-limited`, `contacts`, `location`, `location-always`, `photos-add`, `photos`, `media-library`, `microphone`, `motion`, `reminders` or `siri`. Reset puts back the app's earlier decision for that service: granted, denied, or not yet asked. `photos` and `photos-add`, `location` and `location-always`, and `contacts` and `contacts-limited` change together, so reset restores both services in the pair. If the app already has the requested decision, the change is `unchanged`. If its earlier decision cannot be restored, such as limited Photos access, the request is refused and nothing changes; reset the app's privacy settings first.

Every other condition returns `unsupported` on an iOS Simulator, with the reason. `rootState` and `integrityState` need a bootloader, verified boot or a jailbroken device, and the Simulator has none of them. The `faults` and `vehicle` conditions need Android system services. For `faults.battery`, use `statusBar` to change the displayed battery; for `faults.revokePermission`, use `privacy` with `action: "revoke"`.

## Compound faults

Some faults cause a second fault. Plan your test for both:

- **`revokePermission` restarts the app.** Android kills an app's process when one of its permissions is revoked, so the app is also restarted.
- **`corruptAppFile` force-stops the app** before it damages the file.
- **`clearPackageData` kills the app's process** as well as deleting its data.
- **`clockSkew` restarts adbd.** It needs `adb root`, so it works only on rootable emulators, and the device's adb connection drops briefly while adbd restarts.

## Restore

Every restorable condition is undone, newest first, when any of these happens:

- the session that applied it is released or rebound;
- its lease expires: `expiresInSeconds` (1 to 86,400) restores everything after that many seconds unless a later `deviceCondition` call renews it. Leases need a session;
- you call `{ "deviceCondition": { "reset": true } }`.

Conditions belong to the device, not to the caller that set them. When two sessions, or a session and a call without one, set the same condition on one device, they act on one shared device state. Only the caller that applied it first can undo it: its release or reset clears the condition for both, while the second caller's request reports `unchanged` and its release or reset leaves the condition in place. Give each condition-setting run its own device.

After each reset, AutoMobile reads the device back to check the condition is gone. One-shot faults (`killApp`, `trimMemory`, `clearPackageData`) have nothing to restore, and `"unset"` on them does nothing.

## Result

The result lists each requested change with its status (`applied`, `cleared`, `unchanged` or `unsupported`) and the keys still active on the device. Calls that reset conditions also include `restore`: the keys restored, any `failures` with the key and the reason, and `verifiedClean`. When `verifiedClean` is `false`, the daemon log names each condition left unrestored. That condition stays registered, so the next release or reset tries again.
