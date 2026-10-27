# Android windowing: split screen, picture-in-picture, freeform

Spike notes for #14115 and the `windowMode` tool.

> [!WARNING]
> **Not yet verified on an emulator.** Everything below about device behavior was
> written from the AOSP sources (`ActivityManagerShellCommand`, `ActivityStarter`,
> `TaskDisplayArea`, `Task`, `WindowConfiguration` and the WM Shell's
> `ShellCommandHandler`s), with no emulator available. Treat each command as a
> candidate. The verification checklist at the end lists what to run on API 30, 34
> and 36 images before these notes count as evidence.

## How the tool decides that a command worked

The commands differ by API level and image, and several have changed shape between
releases. So `windowMode` does not trust any single command. It runs candidates in
order and re-reads `dumpsys activity activities` after each one for up to 3 seconds
(polling every 250 ms). It stops at the first candidate whose read-back shows the
requested mode, and bounds or side when those were asked for. Every attempt is
returned (`attempts`), along with the command that reached the mode (`method`). A
command that a release lacks therefore costs one attempt and shows up as `failed` or
`not_reached`. It is never reported as success.

## Reading the mode and bounds

The task's mode and bounds come from `dumpsys activity activities`, the output the
back stack parser already reads, so `observe` reports them in `backStack.tasks[]`
(`windowingMode`, `bounds`) at no extra adb cost. The real captures in
`test/features/observe/activityActivitiesDumps/` (API 24-36) show these sources:

| Source                                                   | API   | Notes                                                                          |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------------------------ |
| `* Task{... mode=<mode> ...}` task header                | 30+   | `WindowConfiguration.windowingModeToString`                                    |
| `Stack #N: type=... mode=<mode>` root-task header        | 28-30 | `RootTask #N:` on API 31. Tasks inside inherit its mode on API 28-29.          |
| `bounds=[l,t][r,b]` under each task                      | 30+   | "Application tokens in top down Z order" section: resolved `getBounds()`       |
| `mBounds=Rect(l, t - r, b)` after a task header          | 24+   | Requested override bounds. `Rect(0, 0 - 0, 0)` means "inherit" and is ignored. |
| `CurrentConfiguration=... winConfig={ mBounds=Rect(...)` | 28+   | Top activity's resolved bounds; the last fallback                              |

Mode strings: `fullscreen`, `pinned` (PiP), `freeform`, `multi-window` (split screen
on API 32+, and the split stage roots), `split-screen-primary` and
`split-screen-secondary` (legacy split screen on API 31 and below), `undefined`. API
24-27 print no mode, so none is reported.

## Commands per API level

`<launch>` below is the launcher-icon start the tool uses to bring an app forward
without stacking a new activity on its task:

```sh
am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER \
  -f 0x10200000 -n <pkg>/<LauncherActivity> --windowingMode <N>
```

`0x10200000` is `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_RESET_TASK_IF_NEEDED`, the
launcher's own flags. `--windowingMode` takes `WindowConfiguration.WINDOWING_MODE_*`:
1 fullscreen, 2 pinned, 3 split-screen primary, 4 split-screen secondary (both removed
in API 33), 5 freeform, 6 multi-window. On API 31+ `TaskDisplayArea.getOrCreateRootTask`
applies the launch windowing mode to a reused root task. On API 30 the reuse path goes
through `getLaunchStack`, so whether an already-running task changes mode there is the
first thing to verify.

WM Shell commands go through
`dumpsys activity service SystemUIService WMShell <command>`. Android 14+ registers
them under a module prefix (`splitscreen moveToSideStage ...`), while 12L and 13
accept them bare. The tool tries the prefixed form first, then the bare form.

### Freeform

| Step   | API 30                                                                                                                             | API 34 | API 36                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Enable | `settings put global enable_freeform_support 1`, `settings put global force_resizable_activities 1` (WMS observes both; no reboot) | same   | same; desktop windowing may also need the developer option (`override_desktop_mode_features`) and a reboot, which the tool does not do |
| Enter  | `<launch>` with `--windowingMode 5`                                                                                                | same   | same, then `WMShell desktopmode moveToDesktop <taskId>`                                                                                |
| Resize | `am task resize <taskId> <l> <t> <r> <b>`                                                                                          | same   | same                                                                                                                                   |
| Leave  | `<launch>` with `--windowingMode 1`                                                                                                | same   | same                                                                                                                                   |

`am task resize` only works on a task that is already freeform or multi-window
(`WindowConfiguration.canResizeTask`). Its help text shows one comma-separated
argument, but `runTaskResize` reads four separate integers; the tool passes four. The
system may clamp bounds to the display or to the app's minimum size. The tool reports
that as a mismatch rather than a success. Phone images whose
`config_freeformWindowManagement` is false may refuse freeform even with both settings
on; the tool then returns `success: false` with the settings receipt.

The two settings are written only when they are not already `1`. Their prior values
(`null` when unset) are returned as `restore.settings`, bound to the device serial and
`/proc/sys/kernel/random/boot_id` like the `setDeviceResources` receipts. Restore writes
them back with `settings put` or `settings delete` and reads them back.

### Picture-in-picture

There is no shell command that puts an arbitrary app into PiP. The app has to declare
`android:supportsPictureInPicture="true"` and enter PiP itself when the user leaves it:
`setAutoEnterEnabled(true)` on API 31+, or `enterPictureInPictureMode()` from
`onUserLeaveHint()`. So `{pip: "enter"}` brings the app forward with `<launch>` (mode 1)
when it is not the resumed task, then sends `input keyevent KEYCODE_HOME` and waits for
`mode=pinned`. `{pip: "exit"}` relaunches with `<launch>` and `--windowingMode 1`. The
same command is expected on 30, 34 and 36. API 30 also has
`am stack move-top-activity-to-pinned-stack`, which the tool does not use because it was
removed later.

### Split screen

| API          | Enter                                                                                                                                                                                                                            | Leave                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 30 (and 31)  | `<launch primary>` with `--windowingMode 3`, then `<launch secondary>` with `--windowingMode 4`. Without `with`, the system shows recents on the other side.                                                                     | `<launch>` with `--windowingMode 1`                                         |
| 32+ (34, 36) | Start `with` if it has no task, bring the app to the top with `<launch>` (mode 1), then `WMShell [splitscreen] moveToSideStage <withTaskId> <position>` (`0` top/left, `1` bottom/right). The app on top becomes the main stage. | `WMShell [splitscreen] exitSplitScreen <appTaskId>`, then `<launch>` mode 1 |

The side is checked from the read-back bounds: primary is the task whose top (or, at
equal tops, left) edge is smaller. When the app lands on the wrong side, the tool runs
`WMShell [splitscreen] switchSplitPosition` once. There is no shell command for the
split ratio, so the tool does not accept one. #14095 tracks a `split_screen` system
action, which is the accessibility route (`GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN`).

## Coordinates in freeform and split screen

No mapping is needed for element taps. CtrlProxy builds the hierarchy from
`AccessibilityNodeInfo.getBoundsInScreen` (see `ViewHierarchyExtractor.kt`). `tapOn`
and the other element tools tap the centre of those bounds through `input tap` or an
accessibility gesture, both of which take absolute display coordinates. So a tap on an
element inside a freeform window at `[120,300][960,1500]` lands on that element without
any offset. `tapAt` and `swipeAt` also take absolute coordinates, matching `observe`'s
`screenSize`. A window-relative coordinate option (offsetting by `backStack.tasks[].bounds`)
is a possible follow-up if callers want it; it is not needed for correctness.

Two cases to check on a device: an app in size-compat mode inside a freeform window,
where the accessibility bounds are scaled by the framework, and a freeform window that
extends past the display edge.

## Restore receipts

Every mutation returns what it changed:

- `previous`: the app task's mode and bounds before the call.
- `restore.mode`: the `mode` argument that puts the window back (`"fullscreen"`,
  `{freeform: {bounds}}`, `{pip: "enter"}`, or `{splitScreen: {with, position}}` with the
  previous partner). It is present only when the window changed.
- `restore.settings`: the freeform settings receipt described above.

`windowMode({appId, restore})` applies the mode first, while freeform support is still
on, then writes the settings back.

## Verification checklist

None of these has been run. Use the Playground (`dev.jasonpearson.automobile.playground`)
and Settings (`com.android.settings`) as the second app. Capture
`adb shell dumpsys activity activities` in each state, replace the hand-reconstructed
files in `test/fixtures/android-windowing/` with the captures, and record the image and
build in that directory's README.

Images: API 30 phone (`google_apis`), API 34 phone and tablet (`pixel_tablet`), API 36
phone, tablet, and a desktop-capable image with desktop windowing enabled.

- [ ] Freeform settings: on each image, does `--windowingMode 5` reach `mode=freeform`
      after the two settings, with no reboot? Which images also need
      `override_desktop_mode_features` or a reboot?
- [ ] API 30: does `<launch>` with `--windowingMode 5` move an already-running task, or
      only a new one?
- [ ] API 36 desktop: does `WMShell desktopmode moveToDesktop <taskId>` exist, and does
      `--windowingMode 5` alone work there?
- [ ] `am task resize <id> l t r b`: four arguments accepted on 30, 34 and 36? Are the
      bounds applied exactly or clamped?
- [ ] Freeform `bounds=[...]` in the Z-order section matches the window on screen.
- [ ] A `tapOn` on a Playground element inside a freeform window lands on the element,
      including when the window is not at the display origin.
- [ ] PiP: with a PiP-capable activity, HOME produces `mode=pinned` on 30, 34 and 36,
      and the `<launch>` mode-1 relaunch expands it. The Playground does not support PiP
      yet (see follow-ups).
- [ ] API 30 and 31: `--windowingMode 3` then `4` produce `split-screen-primary` and
      `split-screen-secondary` app tasks.
- [ ] API 34 and 36: which form of `moveToSideStage` works (prefixed or bare)? Does the
      position argument apply when it is the last argument, or only when another argument
      follows it?
- [ ] API 34 and 36: `exitSplitScreen <taskId>` leaves that task fullscreen on top.
- [ ] Restore: a `restore.settings` receipt puts both settings back, and is refused after
      a reboot.

## Follow-ups

- Playground PiP: an activity or screen that opts into PiP with `setAutoEnterEnabled`,
  without changing what HOME does on the Playground's other screens.
- Split ratio: needs a WM Shell divider command or a drag on the divider.
- Verified captures for each mode (see the checklist above).
