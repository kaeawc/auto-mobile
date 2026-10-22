# Android display geometry fixtures

These fixtures are **hand-reconstructed**, not captured from a device. They follow
the output format of the AOSP shell commands that `displayConfig` reads for the
runtime screen size, navigation mode and display-cutout emulation (#14101):

| Fixture                        | Command            | Reconstructed from                                                                                                   |
| ------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `overlay-list-gestural.txt`    | `cmd overlay list` | `OverlayManagerShellCommand.runList`: target package line, `[x]`/`[ ]` overlay lines, blank line; API 35 overlay set |
| `overlay-list-hole-cutout.txt` | `cmd overlay list` | Same format, with a `---` (not enable-able) overlay and a fabricated `package:name` overlay identifier               |
| `wm-size-physical.txt`         | `wm size`          | `WindowManagerShellCommand.runDisplaySize` with no override                                                          |
| `wm-size-override.txt`         | `wm size`          | `WindowManagerShellCommand.runDisplaySize` with an override                                                          |

Replace them with real captures once an API 35 emulator run records the same
commands. No device commands run in these tests.
