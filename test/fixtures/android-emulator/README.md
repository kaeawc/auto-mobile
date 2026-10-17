# android-emulator fixtures

Representative emulator stdout/stderr excerpts for the pure classifiers in
`src/utils/android-cmdline-tools/emulatorLaunchFailure.ts`. These were NOT captured from a live
failing launch (the failing hosts are sandboxed or headless CI); each reproduces the signature
the classifier matches, in the surrounding line shape the emulator prints. Replace with raw
captures when a failing host is available. `*.txt` is LF-pinned in `.gitattributes`.
