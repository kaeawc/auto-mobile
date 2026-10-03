# android-display fixtures

Captured output, not hand-written.

## foldpf-* (issue #8468)

- Captured 2026-09-30 from AVD `am-fold-pixel10pf` (Pixel 10 Pro Fold, API 36), headless:
  `emulator -avd am-fold-pixel10pf -no-window -no-snapshot-save -no-audio -no-boot-anim`.
- Files are verbatim stdout of `adb shell cmd device_state print-state` (`*-print-state.txt`,
  prints only the committed state identifier) and `adb shell cmd device_state state`
  (`*-state.txt`, prints `Committed state`, plus `Base state` / `Override state` when an
  override is set). `foldpf-print-states.txt` is `cmd device_state print-states`.
- Sequence, each capture taken ~3s after the step:
  1. `1-default`: after boot, no override (state 2 OPENED).
  2. `2-rear-display-override`: after `cmd device_state state 3`.
  3. `3-unfold-while-override`: after `emu unfold` (base already OPENED); stays 3.
  4. `4-fold-while-override`: after `emu fold`; committed state became 0 CLOSED.
  5. `5-after-reset`: after `cmd device_state state reset` (base CLOSED, state 0).
  6. `6-fold-from-closed-base-while-override`: `state 3`, then `emu fold`; stays 3 (bug).
  7. `7-unfold-from-closed-base-while-override`: then `emu unfold`; base OPENED, still 3 (bug).
  8. `8-after-reset-opened-base`: after `state reset`; state 2.

- `hinge-angle0-get.txt`: captured `adb emu sensor get hinge-angle0` output on am-resizable API 36, issue #8947.
