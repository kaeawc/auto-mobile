# Android `dumpsys jobscheduler` fixtures

**Hand-reconstructed, not captured from a device.** No emulator was available when
these were written (#14090). Each file was reconstructed from the AOSP dump code for the
API level in its name, with fictional packages (`dev.example.*`). Replace them with verbatim
captures (`adb -s <serial> shell dumpsys jobscheduler dev.example.playground`) when a device is available, and record the device, build and capture command
here as the other fixture READMEs do.

Source: `JobSchedulerService` and `JobStatus.dump`. The parser reads labelled lines
(`JOB #u0aNNN/<id>:`, `PERIODIC:`, `Required constraints:`, `Run time:`), so the sections that
vary by release (settings, quota, bias) are kept short here.

| File                                      | API | Format points it pins                                                                                                                                                  |
| ----------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dumpsys-jobscheduler-api29-periodic.txt` | 29  | `Registered 2 jobs:` at column 0; a WorkManager periodic job and a plain service job; legacy `Requires:` line and `Network type:`; empty `Pending queue`/`Active jobs` |
| `dumpsys-jobscheduler-api34-running.txt`  | 34  | Indented sections; a job from another package; constraint names followed by `[0x...]`; `Run time: earliest=none`; one job in both `Pending queue` and `Active jobs`    |
| `dumpsys-jobscheduler-api34-none.txt`     | 34  | `Registered 0 jobs:`                                                                                                                                                   |

WorkManager's own diagnostics output (`WM-DiagnosticsWrkr`) is covered by an inline string in
`test/features/backgroundWork/WorkManagerDiagnosticsParser.test.ts`, reconstructed from
`DiagnosticsWorker`.
