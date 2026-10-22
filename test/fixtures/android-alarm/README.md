# Android `dumpsys alarm` fixtures

**Hand-reconstructed, not captured from a device.** No emulator was available when
these were written (#14090). Each file was reconstructed from the AOSP dump code for the
API level in its name, with fictional packages (`dev.example.*`). Replace them with verbatim
captures (`adb -s <serial> shell dumpsys alarm`) when a device is available, and record the device, build and capture command
here as the other fixture READMEs do.

Source: `AlarmManagerService` and `Alarm.dump`. The parser reads `Alarm{...}` headers and the
labelled lines under them (`tag=`, `type=... window=... repeatInterval=... flags=`, `whenElapsed=`,
`operation=`/`listener=`).

| File                      | API | Format points it pins                                                                                                                                     |
| ------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dumpsys-alarm-api29.txt` | 29  | `Alarm{... type N when <ms> <pkg>}` headers; `nowELAPSED=`; relative `whenElapsed=`; a repeating inexact alarm (`window=900000`); another package's alarm |
| `dumpsys-alarm-api34.txt` | 34  | `origWhen`/`whenElapsed` in the header; `policyWhenElapsed:`; exact wakeup flags `0x9`; an alarm with `listener=` instead of `operation=`                 |
