# Emulator and simulator audio

Feed known audio into an Android emulator's or iOS Simulator's microphone and check whether an
app played sound. Use these to test voice notes, voice search, calls, notification sounds and
media playback on headless CI.

All three tools are off by default; enable them with `setToolEnabled`. They work on local Android
emulators and iOS Simulators. Physical devices are refused.

## Android emulators

Each emulator has its own audio channel, so emulators running side by side never hear each
other. The host needs no microphone, speaker or sound server, and this works the same in a
container. Keep audio enabled on the emulator: do not set `AUTOMOBILE_EMULATOR_AUDIO=false`.
The result's `route` is `emulator-grpc`.

## iOS Simulators

A simulator records from the Mac's default input device and plays to its default output device,
so audio goes through loopback devices on the Mac. The result's `route` is `host-loopback`.

Set up the Mac once:

1. Install a loopback audio driver such as BlackHole 2ch.
2. Make the loopback device the default input (for `injectAudioInput`) and the default output
   (for `captureAudio`).
3. Set `AUTOMOBILE_IOS_AUDIO_LOOPBACK_HELPER` to the path of an `audio-loopback-helper`
   executable.
4. Give the process that runs AutoMobile Microphone permission, which `captureAudio` needs to read
   the loopback device.

Every simulator on the Mac shares these devices:

- Only one simulator injection runs at a time per Mac; a second gets `audio_injection_busy`.
- A capture hears every simulator on the Mac. Run audio tests on one simulator at a time.
- With one loopback device as both default input and output, a simulator's own playback also
  reaches its microphone.

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

Records the device's audio output for `seconds` (at most 20) and reports:

- `silent`: true when no 20 ms window reaches `silenceThresholdDbfs` (default -50).
- `rmsDbfs`, `peakDbfs`: overall level; digital silence reports -120.
- `activeRatio`: the share of windows with sound.
- `timedOut`: true when the device produced less audio than asked for. A silent app gives
  `silent: true` and `timedOut: true`, not an error.

With `saveArtifact: true` the capture is also written as a WAV file, and `path` and `sizeBytes`
are returned.

Assert loosely, on `silent` and a rough duration, not on exact waveforms: a loaded host can
glitch real-time audio.

## Errors

Errors start with a code in brackets:

| Code                          | Meaning and what to do                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audio_injection_busy`        | Another injection already feeds this emulator's microphone, or, for a simulator, any simulator's on the same Mac. Stop it first.                                                                            |
| `audio_injection_unsupported` | No route. An emulator is not local or its build has no gRPC audio: use a recent emulator on the same host. A simulator's Mac has no loopback default input or no helper configured: follow the setup above. |
| `audio_capture_unsupported`   | The same, for capture; a simulator needs a loopback default output.                                                                                                                                         |
| `audio_grpc_failed`           | Any other emulator error; the message carries its detail.                                                                                                                                                   |
| `audio_loopback_failed`       | The Mac's audio system refused the loopback device, for example without Microphone permission; the message carries the detail.                                                                              |
