# Device condition fixtures

`setDeviceState` can put an Android device into a fault or root state for a test, then restore it. Send a `deviceCondition` object as the call's only field; it cannot be combined with other `setDeviceState` fields.

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
deviceCondition is behind the 'device-condition' feature flag, which is disabled.
```

Turn it on in the AutoMobile IDE plugin under **Settings > AutoMobile > Feature Flags**. The flag applies to the whole host, not one session.

## Conditions

Set a condition by passing its value. Pass `"unset"` to clear it, or `{ "reset": true }` to restore everything applied on the device.

| Field                                 | What it does                                                                         | Restored on reset                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `rootState: "rooted-detectable"`      | Makes root-detection checks trip (non-Play emulator image with a writable `/system`) | Yes                                                       |
| `faults.battery`                      | `unplug`, `low` (15%) or `full`                                                      | Yes                                                       |
| `faults.lowPower`                     | Battery saver on                                                                     | Yes, to its prior value                                   |
| `faults.doze`                         | Forces deep Doze                                                                     | Yes                                                       |
| `faults.thermal`                      | `throttling` or `critical` thermal status                                            | Yes                                                       |
| `faults.dontKeepActivities`           | Developer option "Don't keep activities" on                                          | Yes, to its prior value                                   |
| `faults.storage`                      | `low` (about 128 MiB free) or `full` (about 8 MiB free)                              | Yes                                                       |
| `faults.corruptAppFile`               | Damages one file in a debuggable app's data directory                                | Yes, from a saved copy                                    |
| `faults.revokePermission`             | Revokes one runtime permission                                                       | Yes, re-granted                                           |
| `faults.disablePackage`               | Disables an app for the current user                                                 | Yes, re-enabled                                           |
| `faults.clockSkew`                    | Moves the device clock `offsetSeconds` from real time, with automatic time off       | Yes, to real time and the original automatic-time setting |
| `faults.killApp`                      | Ends an app's process once (`background` or `forceStop`)                             | No: one-shot                                              |
| `faults.trimMemory`                   | Sends a running app one `onTrimMemory` level                                         | No: one-shot                                              |
| `faults.clearPackageData`             | Clears an app's data                                                                 | No: one-shot, cannot be undone                            |
| `vehicle.motion`, `vehicle.nightMode` | Automotive vehicle state; see [Android Automotive OS](android-automotive.md)         | Yes                                                       |

A condition the device cannot apply comes back `unsupported` with a `detail` reason, and the call reports `success: false`. The call's other changes still apply.

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

After each reset, AutoMobile reads the device back to check the condition is gone. One-shot faults (`killApp`, `trimMemory`, `clearPackageData`) have nothing to restore, and `"unset"` on them does nothing.

## Result

The result lists each requested change with its status (`applied`, `cleared`, `unchanged` or `unsupported`) and the keys still active on the device. Calls that reset conditions also include `restore`: the keys restored, any `failures` with the key and the reason, and `verifiedClean`. When `verifiedClean` is `false`, the daemon log names each condition left unrestored. That condition stays registered, so the next release or reset tries again.
