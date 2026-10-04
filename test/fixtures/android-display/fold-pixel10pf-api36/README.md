## Foldable display inventory: fold-{open,closed}-*.txt

- AVD: `am-fold-pixel10pf` (Pixel 10 Pro Fold profile), serial `emulator-5602`
- API level: 36 (Android 16), fingerprint `google/sdk_gphone64_arm64/emu64a:16/BE2A.250530.026.F3/13894323:userdebug/dev-keys`
- Emulator: Android emulator version 37.1.11.0 (build_id 15917651) (CL:N/A)
- Launch: `emulator -avd am-fold-pixel10pf -port 5602 -no-snapshot-load -no-snapshot-save -no-window` (cold boot, no AutoMobile daemon attached, no `cmd device_state` override in force)
- Date: 2026-10-03 (UTC timestamps of each set are in `fold-{open,closed}-captured-at.txt`)
- Host: macOS (Darwin 25.6.0), arm64

Both postures were captured in one boot, back to back, each set within a few seconds and with no posture change inside a set:

| Posture | How it was reached | `cmd device_state print-state` | `emu sensor get hinge-angle0` |
| --- | --- | --- | --- |
| open (unfolded) | state after cold boot | 2 (OPENED) | 180 |
| closed (folded) | `adb -s emulator-5602 emu fold`, then 6 s wait | 0 (CLOSED) | 0 |

Commands, per posture `P` in `open`, `closed` (run in this order):

| File | Command |
| --- | --- |
| `fold-P-displays.txt` | `adb -s emulator-5602 shell dumpsys display` |
| `fold-P-surfaceflinger.txt` | `adb -s emulator-5602 shell dumpsys SurfaceFlinger --display-id` |
| `fold-P-surfaceflinger-full.txt` | `adb -s emulator-5602 shell dumpsys SurfaceFlinger` (complete dump; it contains the display section) |
| `fold-P-device-state.txt` | `adb -s emulator-5602 shell cmd device_state state` |
| `fold-P-print-state.txt` | `adb -s emulator-5602 shell cmd device_state print-state` |
| `fold-P-hinge-angle0.txt` | `adb -s emulator-5602 emu sensor get hinge-angle0` |
| `fold-P-captured-at.txt` | `date -u +%Y-%m-%dT%H:%M:%SZ` on the host, after the set |
| `fold-print-states.txt` | `adb -s emulator-5602 shell cmd device_state print-states` (posture independent) |

What the pair shows (read from the files, not edited into them):

- SurfaceFlinger lists the same two physical displays in both postures:
  `4619827259835644672` (HWC display 0, port 0, `EMU_display_0`) and
  `4619827551948147201` (HWC display 1, port 1, `EMU_display_1`).
- `dumpsys display` DisplayDeviceInfo: `local:4619827259835644672` is 2076 x 2152 (the inner panel);
  `local:4619827551948147201` is 1080 x 2364 (the cover panel).
- Open: logical display 0 is backed by `local:4619827259835644672` (enabled); the cover panel backs logical display 3 (disabled).
- Closed: logical display 0 is backed by `local:4619827551948147201` (enabled); the inner panel backs logical display 1 (disabled).

So the cover panel id on this AVD is `4619827551948147201` in both postures.

## Notes for test authors

`fold-{open,closed}-displays.txt` contains `adb shell dumpsys display`, with
multi-line `Display N:` blocks and `mBaseDisplayInfo=DisplayInfo{...}` records.
`parseAndroidDisplayInfos` consumes only `adb shell cmd display get-displays`
(`Display id N:` records), so it returns `[]` for these dumps. No
`cmd display get-displays` capture exists for this consistent pair; real
`logicalDisplayIdForPanel` cover-panel mapping still needs a follow-up capture of
`adb shell cmd display get-displays` in both postures. Do not derive or invent a
get-displays fixture from these dumps.

The older `../fold-displays.txt` cover ID `4619827259835644673` is not corroborated
by any real capture here: the cover is `4619827551948147201` throughout this pair.
The older fixture's provenance is undocumented; the discrepancy's cause is unknown.
