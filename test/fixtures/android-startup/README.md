# Android startup-timing fixtures

Output shapes for `measureStartup` (#14112): `am start -W`, `cmd package resolve-activity --brief`
and `logcat -v epoch` activity-manager lines.

Captured verbatim from an API 35 `google_apis` arm64 emulator (Pixel 6 profile) with a minimal
debuggable app (`dev.l18722.dbg`) that calls `reportFullyDrawn()` 1.5 s after launch:

| File                               | Command                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `am-start-W-cold-api35.txt`        | `am force-stop`, then `am start -W -a MAIN -c LAUNCHER -n <component>`           |
| `am-start-W-hot-api35.txt`         | `input keyevent HOME`, then the same `am start -W`                               |
| `am-start-W-warm-api35.txt`        | the same `am start -W` with `--activity-clear-task` (process alive)              |
| `am-start-W-already-top-api35.txt` | the same `am start -W` while the activity is already on top                      |
| `logcat-fully-drawn-api35.txt`     | `logcat -d -v epoch -T <launch time> -s ActivityTaskManager:I ActivityManager:I` |
| `resolve-activity-launcher.txt`    | `cmd package resolve-activity --brief -a MAIN -c LAUNCHER <package>`             |

The `*-api28.txt` files are still reconstructed from the AOSP output format (no API 28 device was
available) and are not captures. Replace them with verbatim captures when one is taken; the parser
tests read only these files, so a capture is a drop-in swap.
