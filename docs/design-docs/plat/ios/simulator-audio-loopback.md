# iOS Simulator audio loopback

`injectAudioInput` and `captureAudio` reach an iOS Simulator through the Mac's CoreAudio loopback
devices (#13628, #13629). The emulator route is in
[Emulator gRPC audio](../android/emulator-grpc-audio.md).

## Route

- A simulator records from the host default input and plays to the host default output.
- Injection plays into the default input device's output side; capture reads the default output
  device's input side.
- Both need a loopback device: a virtual transport, or a known loopback driver name (BlackHole,
  Loopback, Soundflower, VB-Cable, Background Music), with streams in both directions. A duplex
  headset has both directions but routes neither into the other, so it is refused. This is the
  same rule the capability inventory uses for `audioOutputCapture`.
- The helper resolves both devices by UID at each call, never by a cached numeric device id, since
  ids change across HAL restarts.

## Helper

`ios/audio-loopback` builds `audio-loopback-helper`, a Swift CLI over AudioQueue. It is located
through `AUTOMOBILE_IOS_AUDIO_LOOPBACK_HELPER`; there is no released build yet.

- `play --sample-rate N`: reads 16-bit little-endian mono PCM from stdin into the injection device.
  It reads one 50 ms buffer each time the queue frees one, so the daemon's writes are paced by
  real-time playback. EOF drains the queue and exits 0. `SIGTERM` stops playback at once.
- `capture --duration-ms N --sample-rate N`: writes the same format to stdout and exits 0 after
  the duration. Reading an input device needs Microphone permission for the helper's process.
- `capture --until-stopped --sample-rate N`: the same, until stdin closes; the helper then writes
  its last buffer and exits 0. Recordings with audio use this. The capture counts as complete only
  on exit 0 with stdout closed within 1 s (time the recording is still writing earlier audio to disk
  does not count): a helper still running 2 s after stdin closes is sent `SIGTERM`, and that, a
  crash, or a pipe left open fails the capture so its tail is never silently lost.
- Stderr carries one marker per line: `audio-loopback-ready: <device name>` once the device is
  open, or `audio-loopback-error: <code> <message>` before a non-zero exit.

| Helper code          | Tool error                    |
| -------------------- | ----------------------------- |
| `no_loopback_input`  | `audio_injection_unsupported` |
| `no_loopback_output` | `audio_capture_unsupported`   |
| anything else        | `audio_loopback_failed`       |

The daemon waits up to 5 s for the ready marker before it kills the helper. A daemon crash closes
the helper's stdin, so `play` drains and exits on its own; `capture` ends at its duration. No
helper outlives its call by more than that.

## Isolation

The default devices are shared by every simulator on the host, and one `SimAudioProcessorService`
serves all of them, so there is no per-simulator separation on this route.

- The service allows one host-loopback injection at a time; a second start, including one racing
  the first's start, is `audio_injection_busy`.
- A capture hears every simulator on the host.

Per-simulator isolation needs a device pair per simulator, pinned through CoreSimulator's per-device
audio routing (#13631-#13633). That is not built yet.
