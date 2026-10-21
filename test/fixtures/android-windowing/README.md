# Android windowing `dumpsys activity activities` fixtures

**Hand-reconstructed, not captured from a device.** No emulator was available when
these were written (#14115). Each file was reconstructed from the AOSP dump code
(`Task.toFullString`, `TaskFragment.dumpInner`, `ActivityRecord.dump`, and the
"Application tokens in top down Z order" section printed by
`WindowContainer.dumpChildrenNames`) for the API level in its name, and trimmed. The
surrounding layout follows the real captures in
`test/features/observe/activityActivitiesDumps/`, which are verbatim. Replace these
files with verbatim captures (`adb -s <serial> shell dumpsys activity activities`) once
the Playground has been driven into each mode on a device, and record the device,
build and capture command here as the other fixture READMEs do.

The app tasks use the Playground package `dev.jasonpearson.automobile.playground`.

| File                                      | API | Format points it pins                                                                                                                                                                                                                    |
| ----------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dumpsys-activity-api30-freeform.txt`     | 30  | `Stack #N: ... mode=freeform` with an empty stack `mBounds`; the task's own non-empty `mBounds=Rect(...)`; `bounds=[l,t][r,b]` in the Z-order section                                                                                    |
| `dumpsys-activity-api30-split-screen.txt` | 30  | Legacy split: `split-screen-primary` / `split-screen-secondary` stacks with non-empty stack `mBounds` and empty task `mBounds`                                                                                                           |
| `dumpsys-activity-api34-split-screen.txt` | 34  | Shell split: organizer-created root and stage tasks; app tasks nested in `multi-window` stages with no own `mBounds`, so bounds come from the Z-order section only                                                                       |
| `dumpsys-activity-api34-pip.txt`          | 34  | `mode=pinned` task with its PiP `mBounds`, `PictureInPictureParams` dump, launcher resumed                                                                                                                                               |
| `dumpsys-activity-api34-freeform.txt`     | 34  | Top-level `mode=freeform` task with `mBounds`                                                                                                                                                                                            |
| `dumpsys-activity-api36-desktop.txt`      | 36  | Desktop windowing on a 2560x1600 tablet: two `freeform` tasks, no `mDisplayWindowingMode` in `winConfig` (dropped on API 36). Whether desktop tasks sit under a desk root task depends on the build's desktop flags; this file has none. |
