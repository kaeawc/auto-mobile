# Android foldable display captures

These are real, complete, unmodified captures from AVD `am-fold-pixel10pf`, API 36,
on 2026-10-03, during one boot, using `adb shell cmd display get-displays`.

- `fold-open-get-displays.txt`: device state 2 OPENED (as booted); lists only the
  inner panel `local:4619827259835644672`, real 2076 x 2152.
- `fold-closed-get-displays.txt`: device state 0 CLOSED after `emu fold`; lists
  only the cover panel `local:4619827551948147201`, real 1080 x 2364.

The other panel is absent from the list in each posture. Both listed displays
use logical id 0. The files were copied verbatim from `/tmp/mtb10/captures/` and
verified with `cmp`; capture facts come from that directory's `README.md`.
