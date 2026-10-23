# Android profiling fixtures (`captureTrace` / `heapDump`, #14113)

**Hand-reconstructed, not captured from a device.** No emulator, KVM or Android SDK was
available when these were written. Each file reproduces what the named command prints,
reconstructed from AOSP (`ActivityManagerShellCommand` `dumpheap`, the Perfetto `perfetto`
client's `--background` pid line, `PackageManagerService` flag dump). Replace them with verbatim
captures when a device is available, and record the device, API level and capture command here.

| File                                    | Command                                | Format point it pins                                              |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `dumpsys-package-release-flags.txt`     | `dumpsys package <pkg>` (flags lines)  | Non-debuggable app: `pkgFlags` has no `DEBUGGABLE`                |
| `dumpsys-package-profileable-flags.txt` | `dumpsys package <pkg>` (flags lines)  | **Guess:** a profileable-by-shell token in `privateFlags`         |
| `am-dumpheap-not-debuggable.txt`        | `am dumpheap <pkg> <path>`             | SecurityException refusal text for a non-debuggable app           |
| `am-dumpheap-unknown-process.txt`       | `am dumpheap <pkg> <path>` (not run)   | Process-not-found text                                            |
| `am-dumpheap-success.txt`               | `am dumpheap <pkg> <path>`             | Current releases print the path and block until the dump finishes |
| `perfetto-background-start.txt`         | `perfetto --background -c - --txt ...` | Last line is the detached recorder's pid                          |
| `perfetto-background-missing.txt`       | `perfetto ...` on an image without it  | No pid line, so the start fails                                   |

The debuggable-app case uses the verbatim capture in `test/fixtures/android-dumpsys-package/`
(`dumpsys-package-installed.txt`, the debuggable Playground; `dumpsys-package-not-installed.txt`
for a missing package).

The profileable token name is the least certain part: AOSP exposes profileable-by-shell through
`ApplicationInfo.isProfileableByShell()`, and whether and how `dumpsys package` prints it is
unverified. `heapDump` therefore refuses only when the flags parse and show neither `DEBUGGABLE`
nor a `PROFILEABLE` token, and still maps `am dumpheap`'s own refusal to the same typed error.
