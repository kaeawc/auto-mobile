# Emulator gRPC audio

How AutoMobile injects microphone audio into, and captures audio output from, an Android
emulator. This is the Android mechanism behind `injectAudioInput` and `captureAudio`
(#13628, #13629). Code: `src/utils/android-cmdline-tools/emulatorGrpc/` and
`src/utils/audio/pcm.ts`.

## Why gRPC

The emulator's `EmulatorController` service exposes two RPCs that move PCM through the
emulator's own audio forwarder:

| RPC                                                     | Shape         | Direction                |
| ------------------------------------------------------- | ------------- | ------------------------ |
| `injectAudio(stream AudioPacket) returns (Empty)`       | client stream | host to guest microphone |
| `streamAudio(AudioFormat) returns (stream AudioPacket)` | server stream | guest output to host     |

Each emulator has its own gRPC port, so two emulators cannot hear each other's audio. Nothing
touches a host audio stack, so this works the same on a laptop, a Linux CI host with no
`/dev/snd` and no PulseAudio/PipeWire, and inside a container. Host-mic passthrough
(`-allow-host-audio`) is not used. A per-emulator PulseAudio/PipeWire sink is a fallback that
is only worth building if some supported environment cannot reach the gRPC port.

## Wire contract

- Package `android.emulation.control`; paths are
  `/android.emulation.control.EmulatorController/injectAudio` and `.../streamAudio`.
- Plaintext HTTP/2 on `localhost:<grpc.port>`, gRPC length-prefixed framing, no compression.
- `AudioFormat`: `samplingRate` (1), `channels` (2, `Mono=0`, `Stereo=1`), `format`
  (3, `AUD_FMT_U8=0`, `AUD_FMT_S16=1`), `mode` (4, `MODE_UNSPECIFIED=0`,
  `MODE_REAL_TIME=1`). `AudioPacket`: `format` (1), `timestamp` µs (2), `audio` (3).
- The protobuf codec is hand-written for these three messages; there is no protobuf runtime
  dependency.

## Injection

- Source audio is decoded from WAV, downmixed to mono S16, and resampled to 48 kHz when it is
  above that. The emulator rejects rates above 48 kHz and oversized packets with
  `INVALID_ARGUMENT`.
- Packets carry 20 ms of audio. Only the first packet carries `AudioFormat`; the emulator
  ignores it on later packets.
- `MODE_UNSPECIFIED` lets the emulator pull audio as the guest consumes it (about a 300 ms
  buffer), so HTTP/2 flow control paces the writer. The client never sleeps between packets.
- `loop`, `startDelayMs` and `maxDurationMs` are client-side. `stop()` cancels the stream
  (RST_STREAM CANCEL) rather than half-closing it, because a write can be blocked on
  back-pressure. It is idempotent and resolves with the frames sent.

## Capture

- One `AudioFormat` request (mono S16, 48 kHz by default), then packets arrive every 20–30 ms
  while the guest produces audio.
- `streamAudio` can block forever when the guest is silent. The client sets a deadline of the
  requested duration plus 2 s, cancels the call when it fires, and returns the PCM it has
  (possibly empty) with `timedOut: true`. Silence is a result, not an error.
- The client cancels the stream once it has the requested number of frames.
- Levels come from `analyzeLevels`: overall RMS and peak in dBFS (floor −120), and the share
  of 20 ms windows at or above the silence threshold (default −50 dBFS). A clip is `silent`
  only when no window reaches the threshold, so a short sound in a long capture still counts.
  Assertions should be loose (non-silent, duration within a margin), not waveform matches,
  because loaded CI hosts glitch real-time audio.

## Discovery and auth

- The emulator writes `pid_<pid>.ini` under `<dir>/avd/running`, where `<dir>` is, in order:
  `$ANDROID_EMULATOR_HOME`, `$ANDROID_SDK_HOME/.android`, `$ANDROID_AVD_HOME`,
  `~/.android`, then `$XDG_RUNTIME_DIR` or `/run/user/<uid>` on Linux and
  `~/Library/Caches/TemporaryItems` on macOS.
- The emulator for `emulator-<N>` is the file whose `port.serial` is `N`. Files whose pid is
  no longer running are skipped, because a crashed emulator leaves its file behind and a later
  emulator can reuse the port.
- Auth, in order of preference:
  - `grpc.token` (present when launched with `-grpc-use-token`): `authorization: Bearer <token>`.
  - `grpc.jwks` and `grpc.jwk_active`: the client writes a public ES512 (P-521) JWK to
    `<grpc.jwks>/<kid>.jwk`, waits up to 1 s for the emulator to list that `kid` in
    `grpc.jwk_active`, then signs a token per call with `aud: [<method path>]`, `iss`, `iat`
    and a 15-minute `exp`. The key file is removed on close; the emulator also deletes the
    directory on exit.
  - Neither: no `authorization` header.

## Errors

| Emulator outcome                                                             | Code                          | Meaning                                                             |
| ---------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `FAILED_PRECONDITION` on `injectAudio`                                       | `audio_injection_busy`        | Another injection holds this emulator's microphone. Stop it first.  |
| `UNIMPLEMENTED` or `UNAVAILABLE` (incl. connection refused) on `injectAudio` | `audio_injection_unsupported` | No usable gRPC audio endpoint: old build, gRPC off, or `-no-audio`. |
| `UNIMPLEMENTED` or `UNAVAILABLE` on `streamAudio` with no audio received     | `audio_capture_unsupported`   | Same, for capture.                                                  |
| Any other non-OK status                                                      | `audio_grpc_failed`           | Carries the gRPC code and message.                                  |
| JWK never loaded                                                             | actionable error              | Restart the emulator or launch it with `-grpc-use-token`.           |

A client-cancelled call (`CANCELLED`) is the normal end of `stop()` and of capture, not a failure.

## Open questions

These need a real emulator (#13634):

- The minimum emulator version that ships both RPCs, and whether every CI image meets it.
- Whether `injectAudio` fails loudly or silently no-ops on an emulator launched with
  `-no-audio`.
- Whether the JWT flow above is accepted as-is by the emulator builds CI uses.
