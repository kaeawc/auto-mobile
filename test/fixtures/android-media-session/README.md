# Android `dumpsys media_session` fixtures

**Hand-reconstructed, not captured from a device.** No emulator was available when
these were written (#14117). Each file was reconstructed from the AOSP
`MediaSessionService`, `MediaSessionStack`, `MediaSessionRecord` and
`PlaybackState.toString()` dump code for the API level in its name, with fictional
packages and metadata. Replace them with verbatim captures
(`adb -s <serial> shell dumpsys media_session`) when a device is available, and
record the device, build and capture command here as the other fixture READMEs do.

Trailing whitespace was removed (the real output leaves a trailing space after
empty `listener package:` values); the parser ignores those lines.

| File                                      | API | Format points it pins                                                                                                                                 |
| ----------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dumpsys-media-session-api28-playing.txt` | 28  | Numeric `state=3`; `metadata:size=` with no space after the colon; `speed=1.25`; a `null` album in the description                                    |
| `dumpsys-media-session-api30-playing.txt` | 30  | Numeric `state=3`; `metadata: size=`; numeric `volumeType=1, controlType=2`                                                                           |
| `dumpsys-media-session-api34-playing.txt` | 34  | Named `state=PLAYING(3)`; two sessions, one inactive and paused; a custom action whose name contains a comma; `volumeControlId`; `SET_PLAYBACK_SPEED` |
| `dumpsys-media-session-api34-paused.txt`  | 34  | The same dump after a `pause` dispatch: `state=PAUSED(2)`, `speed=0.0`                                                                                |
| `dumpsys-media-session-api34-idle.txt`    | 34  | No sessions; `Media button session is null`                                                                                                           |
