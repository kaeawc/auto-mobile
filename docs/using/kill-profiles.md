# Kill profiles

`killProfile` simulates the effects of Android background restrictions on one installed app.
Profiles approximate OEM policies; their evidence status and notes describe the limits.
Use `action: "list"` to see profile versions, steps, evidence and non-emulatable behavior.

| Parameter  | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `action`   | `apply`, `reset` or `list`                                       |
| `appId`    | Android package name; required for apply and reset               |
| `profile`  | Profile id; required for apply                                   |
| `baseline` | Reset only: write AOSP defaults if no original state is recorded |

For example, apply `{ "action": "apply", "appId": "com.example.app", "profile": "samsung-sleeping" }`,
then restore with `{ "action": "reset", "appId": "com.example.app" }`.

Apply runs the recipe in order. Each step reports `applied`, `unsupported` (for example,
an older Android version) or `failed`, with a reason. For steps with read-back, `applied`
means Android returned the expected state after the command. A command accepted without
an error can still fail read-back; inspect the observed value in `reason`. The overall
status is `applied` when every step applies, `partial` when some apply and `unsupported`
when none can apply. If no step applies and a step fails, the call returns an error.
Later steps still run after a step reports failed or unsupported; cancellation stops the call.

Reset restores the state captured before the first change, including after repeated applies.
It restores device-wide battery, Doze and screen state as well as the package's restrictions.
A daemon session also restores recorded changes on release or rebind; check
`restore.onSessionRelease`. Sessionless calls need an explicit reset. Records are in memory:
a daemon restart loses them. Without records, reset changes nothing unless `baseline: true`.
Baseline resets the supported battery, Doze, standby, appop and hibernation defaults; it cannot
recover lost permission grants or the original screen state. Force-stop, killed processes
and the previous foreground app cannot be restored. Open the app again to clear force-stop.

## Steps and profiles

| Step kind                | Effect and restore                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batteryUnplug`          | Reports battery power; removes its battery override on reset                                                                                                                                 |
| `standbyBucket`          | Sets rare (API 28+) or restricted (API 30+); verifies and restores the original bucket                                                                                                       |
| `appOp`                  | Restricts background execution, wake locks, exact alarms or notifications; verifies and restores the original mode; API support varies by operation                                          |
| `notificationPermission` | Revokes notification permission (API 33+); verifies denial and restores an original grant                                                                                                    |
| `runtimePermissions`     | Revokes every currently granted runtime permission (API 23+); verifies none of that set remains granted and regrants exactly the captured set on reset; zero grants is an applied no-op      |
| `hibernation`            | Enables hibernation (API 31+); verifies and restores its original state                                                                                                                      |
| `forceIdle`              | Forces deep Doze (API 23+); unforces on reset; device must support Doze                                                                                                                      |
| `home`                   | Backgrounds the app with Home; no restore                                                                                                                                                    |
| `foregroundChange`       | Opens Settings and verifies the top resumed package differs from the target; no restore                                                                                                      |
| `screenOff`              | Sleeps the screen, checks for Asleep up to 10 times 500 ms apart (Dozing is still pending), then waits the stated minutes **inside the call**; reset wakes it only if it was initially Awake |
| `kill`                   | Soft: kills background processes; hard: force-stops the package; no restore                                                                                                                  |
| `bootReceiverCheck`      | Observes boot receivers, boot permission, stopped state and pending alarms; changes nothing                                                                                                  |

| Profile                     | Ordered recipe                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `samsung-sleeping`          | Battery unplug → restricted bucket                                                          |
| `samsung-deep-sleeping`     | Hard kill → background restriction → wake-lock denial                                       |
| `samsung-auto-disable`      | Runtime permissions revoke → hibernation                                                    |
| `samsung-foreground-kill`   | Foreground change → hard kill (Game Booster / Good Guardians approximation)                 |
| `screen-off-stop`           | Screen off for one minute → hard kill (Asus, Meizu, realme and Tecno cleanup approximation) |
| `xiaomi-autostart-off`      | Hard kill → background restriction → boot receiver check                                    |
| `oneplus-deep-optimization` | Hard kill → background restriction                                                          |
| `recents-swipe-kill`        | Home → soft kill                                                                            |
| `recents-swipe-force-stop`  | Home → hard kill                                                                            |
| `oneplus-sleep-standby`     | Battery unplug → deep Doze                                                                  |
| `motorola-adaptive`         | Rare bucket                                                                                 |
| `user-restricted`           | Background restriction                                                                      |
| `exact-alarm-denied`        | Exact alarm denial                                                                          |
| `notifications-off`         | Notification permission revoke                                                              |
| `huawei-powergenie`         | Restricted bucket → background restriction → wake-lock denial → boot receiver check         |
| `vivo-autostart`            | Background restriction → restricted bucket → boot receiver check                            |
| `realme-power-saver`        | Battery unplug → restricted bucket → background restriction                                 |
| `meizu-flyme-background`    | Background restriction → wake-lock denial                                                   |
| `asus-power-master`         | Restricted bucket → background restriction                                                  |
| `sony-stamina`              | Battery unplug → background restriction → exact alarm denial                                |
| `tecno-app-halt`            | Background restriction → wake-lock denial                                                   |

OEM exemption lists and triggers such as “unused for N days” remain non-emulatable.
Hibernation alone does not revoke permissions of preinstalled apps; the permission step is explicit.

## Vendor profiles

These seven profiles are `inferred` from [dontkillmyapp.com](https://dontkillmyapp.com)
(CC-BY-4.0), credited in `killProfile list` and `manufacturerProfile describe`.
Time-based kills, vendor whitelists, proprietary permissions and OEM settings UI cannot
be emulated on a stock device. Separate profiles below approximate additional kill effects;
they do not run as part of these vendor profiles.

| Vendor | Profile                  | Vendor behaviour -> step                                                                                                                                                                                                                               | Not emulated                                                                                                                                                                   |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Huawei | `huawei-powergenie`      | Battery > App launch “Manage manually” off → restricted bucket + `RUN_ANY_IN_BACKGROUND` ignore + `WAKE_LOCK` ignore + boot receiver observation. `samsung-foreground-kill` gives a foreground-change kill; `screen-off-stop` gives a screen-off kill. | PowerGenie/HwPFWService killing every non-whitelisted app after about 60 minutes in the background, using a Huawei-maintained whitelist; System Manager Smart tune-up cleanup. |
| Vivo   | `vivo-autostart`         | Android 13 background power restriction → background restriction + restricted bucket + boot receiver observation.                                                                                                                                      | Proprietary Autostart permission (stock delivery is only observed); taskbar app lock.                                                                                          |
| realme | `realme-power-saver`     | Power saving on battery + App battery management Optimize → battery unplug + restricted bucket + background restriction. `screen-off-stop` approximates screen-off cleanup.                                                                            | Super power saving mode's 6-app limit; auto power-saving trigger levels; OEM sleep schedules.                                                                                  |
| Meizu  | `meizu-flyme-background` | Background processes not allowed → background restriction. Keep running after screen off off → `WAKE_LOCK` ignore. `screen-off-stop` gives a screen-off kill.                                                                                          | Protected apps list; Power plan.                                                                                                                                               |
| Asus   | `asus-power-master`      | Power Master auto-deny of auto-start → restricted bucket + `RUN_ANY_IN_BACKGROUND` ignore. `screen-off-stop` approximates “Clean up in suspend”.                                                                                                       | Power Master's own whitelist and settings UI.                                                                                                                                  |
| Sony   | `sony-stamina`           | STAMINA mode on battery → battery unplug + background restriction + exact alarm denial.                                                                                                                                                                | Time-based “Prefer battery time” STAMINA level limits after screen off; Power-saving feature Excepted list; Intelligence Engine.                                               |
| Tecno  | `tecno-app-halt`         | Power Saving Management For Apps denial → background execution + wake-lock denial. `screen-off-stop` approximates Power Marathon screen-off cleanup.                                                                                                   | App-freeze (“frozen in time”) of timers and foreground services; night-time Sleep Mode airplane-mode schedule; Auto-start management allow-list.                               |

## Boot receiver observation

The check reports an `observation` and a one-line reason:

| Field                    | Meaning                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `bootReceivers`          | Unique package components registered for `android.intent.action.BOOT_COMPLETED`                                           |
| `bootPermissionGranted`  | Whether `RECEIVE_BOOT_COMPLETED` is granted                                                                               |
| `stopped`                | Package's User 0 stopped flag                                                                                             |
| `bootBroadcastDelivered` | Predicted default delivery: receiver exists, permission granted and package not stopped; this is not a measured broadcast |
| `pendingAlarms`          | Number of pending alarm rows for the package; excludes the “Next wake from idle” summary                                  |

Shell cannot send the protected `BOOT_COMPLETED` broadcast: Android rejects it with
`SecurityException`. Root checks on stock Android API 35 show a force-stopped package gets
no default broadcast and starts no process, but receives it with `--include-stopped-packages`.
A non-stopped package receives it even with `RUN_ANY_IN_BACKGROUND=ignore` or the restricted
standby bucket. Given a receiver and permission, only stopped state blocks default delivery
on stock Android; proprietary OEM autostart gates are not reproduced by this observation.

## Errors and recovery

Apply and reset require Android and an installed package. Correct the device or package and retry.
For unsupported steps, inspect the minimum API or device capability in the reason.
For failed read-back, inspect the observed value: fixed permissions and preinstalled apps can
resist restrictions. A failed boot dump is a failed check, not evidence of blocked delivery.
Restore records survive uncertain writes and failed verification so reset can clean up partial changes.
Retry reset after a restore error; failed facets remain recorded. Cancelling a screen-off wait
stops subsequent steps; reset or session release can still wake an originally awake screen.
