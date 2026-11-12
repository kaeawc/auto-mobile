# Android windowing: verification plan and follow-ups

- Kind: idea
- Date: 2026-10-21
- Source: moved from `how-it-works/plat/android/windowing.md`; #14115, #14095, #14373
- Shaped: [Android windowing: split screen, picture-in-picture, freeform](../how-it-works/plat/android/windowing.md)

## Context

The `windowMode` notes were written from the AOSP sources with no emulator available. Before they
count as evidence, the commands need runs on API 30, 34 and 36 images.

## Open device questions

- API 30: whether an already-running task changes mode through `<launch>` with `--windowingMode`
  (the reuse path goes through `getLaunchStack`) is the first thing to verify.
- Coordinates: an app in size-compat mode inside a freeform window, where the accessibility bounds
  are scaled by the framework, and a freeform window that extends past the display edge.

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
- Window-relative coordinates: an option offsetting by `backStack.tasks[].bounds` if callers want
  it; it is not needed for correctness.
- Split-screen system action: #14095 tracks a `split_screen` system action, the accessibility route
  (`GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN`).
