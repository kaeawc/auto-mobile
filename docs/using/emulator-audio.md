# Emulator audio

Feed known audio into an Android emulator's microphone and check whether an app played sound. Use
these to test voice notes, voice search, calls, notification sounds and media playback on
headless CI.

All three tools are off by default; enable them with `setToolEnabled`. They work on local Android
emulators only. Physical devices and iOS are refused.

Each emulator has its own audio channel, so emulators running side by side never hear each
other. The host needs no microphone, speaker or sound server, and this works the same in a
container. Keep audio enabled on the emulator: do not set `AUTOMOBILE_EMULATOR_AUDIO=false`.

AutoMobile starts each emulator it boots with a gRPC port (`-grpc`) on a free host port from 8554
to 8653, held while that emulator runs, so no extra launch flags are needed. A `-grpc` flag you
pass in `AUTOMOBILE_EMULATOR_ARGS` or in the launch's extra arguments is used as given.

## injectAudioInput

Plays audio into the microphone and returns as soon as it starts.

| Parameter       | Description                                                                     |
| --------------- | ------------------------------------------------------------------------------- |
| `file`          | Host path to an uncompressed PCM WAV file (up to 50 MB).                        |
| `tone`          | `{ frequencyHz?, durationMs? }`: a built-in sine tone, default 1000 Hz for 2 s. |
| `loop`          | Repeat until stopped. A loop with no `maxDurationMs` stops after 10 minutes.    |
| `startDelayMs`  | Wait before the first audio, so the app can start recording.                    |
| `gainDb`        | Gain, from -60 to +20 dB.                                                       |
| `maxDurationMs` | Stop after this long.                                                           |

Pass `file` or `tone`, not both. With neither, a 2-second tone plays.

The result has `injectionId`, `durationMs` (of one pass), `sampleRate` and `route`. In a session,
releasing the session stops the injection. Without a session, the injection stops when a session
takes the device. A relative `file` path is relative to the directory the server was started in.

## stopAudioInput

Stops an injection by `injectionId`, on the device it was started on. Stopping one that already
ended is not an error: you get its result again, with `framesSent` and `reason` (`completed`,
`stopped` or `max_duration`). The server keeps the last 64 ended injections; an older id, or any
id after a server restart, is an error.

## captureAudio

Records the emulator's audio output for `seconds` (at most 20) and reports:

- `silent`: true when no 20 ms window reaches `silenceThresholdDbfs` (default -50).
- `rmsDbfs`, `peakDbfs`: overall level; digital silence reports -120.
- `activeRatio`: the share of windows with sound.
- `timedOut`: true when the emulator produced less audio than asked for. A silent app gives
  `silent: true` and `timedOut: true`, not an error.

With `saveArtifact: true` the capture is also written as a WAV file, and `path` and `sizeBytes`
are returned.

Assert loosely, on `silent` and a rough duration, not on exact waveforms: a loaded host can
glitch real-time audio.

## Errors

Errors start with a code in brackets:

| Code                          | Meaning and what to do                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `audio_injection_busy`        | Another injection already feeds this emulator's microphone. Stop it first.                                           |
| `audio_injection_unsupported` | The device is not a local emulator, or its emulator build has no gRPC audio. Use a recent emulator on the same host. |
| `audio_capture_unsupported`   | The same, for capture.                                                                                               |
| `audio_grpc_failed`           | Any other emulator error; the message carries its detail.                                                            |
