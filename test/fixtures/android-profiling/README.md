# Android profiling fixtures (`performanceTrace` categories / `heapDump`, #14113)

**Hand-reconstructed, not captured from a device.** No emulator, KVM or Android SDK was
available when these were written. Each file reproduces what the named command prints,
reconstructed from AOSP (`ActivityManagerShellCommand` `dumpheap`, the Perfetto `perfetto`
client's `--background` pid line, `PackageManagerService` flag dump). Replace them with verbatim
captures when a device is available, and record the device, API level and capture command here.

| File                                    | Command                                | Format point it pins                                              |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `dumpsys-package-profileable-flags.txt` | `dumpsys package <pkg>` (flags lines)  | Captured (API 35): a profileable app prints no profileable token  |
| `native-heap-unavailable.txt`           | `am dumpheap -n <pkg> <path>` file     | Captured (API 35 emulator): the 170-byte placeholder, exit 0      |
| `am-dumpheap-not-debuggable.txt`        | `am dumpheap <pkg> <path>`             | SecurityException refusal text for a non-debuggable app           |
| `am-dumpheap-unknown-process.txt`       | `am dumpheap <pkg> <path>` (API 35)    | Process-not-found text                                            |
| `am-dumpheap-success.txt`               | `am dumpheap <pkg> <path>`             | Current releases print the path and block until the dump finishes |
| `perfetto-background-start.txt`         | `perfetto --background -c - --txt ...` | Last line is the detached recorder's pid                          |
| `perfetto-background-missing.txt`       | `perfetto ...` on an image without it  | No pid line, so the start fails                                   |

The debuggable-app case uses the verbatim capture in `test/fixtures/android-dumpsys-package/`
(`dumpsys-package-installed.txt`, the debuggable Playground; `dumpsys-package-not-installed.txt`
for a missing package).

`dumpsys-package-profileable-flags.txt` and `native-heap-unavailable.txt` are verbatim captures from an API 35 google_apis emulator (#18747). A profileable app's flags are identical to a release app's, so `heapDump` leaves eligibility to `am dumpheap`'s own refusal.
