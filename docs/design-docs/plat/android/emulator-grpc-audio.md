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
- `EmulatorAudioService` owns live injections, one gRPC connection each, keyed by injection id
  and recording the starting session. Session release and unbind stop that session's injections
  as pending device cleanup, and a session acquiring a device stops the sessionless ones on it,
  so the next owner never gets a microphone still being fed. A start that finishes after its
  session's release committed is stopped by the tool itself. The last 64 ended injections keep
  their result (or failure) for a later `stopAudioInput`, which must name the same device.
- Source files are read through a handle with a byte cap and must be regular files, so a device
  file or a file that grows while being read cannot exceed the 50 MB limit.

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

## Audio tracks in recordings

A recording started with `audio: true` (#13629) is wrapped by `AudioTrackVideoCaptureBackend`:

- Before the video capture starts it opens an open-ended capture on the device's route (gRPC
  `streamAudio` with no deadline, or the loopback helper's `--until-stopped`) and appends the PCM to
  `<recording>.audio.pcm`, so a long recording never sits in memory.
- At stop, after the video is final, it ends the capture and muxes with ffmpeg: video copied, audio
  AAC, the audio captured before the video started skipped (`-ss`), and the track padded with
  silence to the video's length (`apad` + `-shortest`). A silent guest sends no packets, so an
  empty capture becomes `anullsrc`. The muxed file replaces the original.
- A failed capture or mux keeps the video, sets `hasAudioTrack: false` and adds a warning; a failed
  start or a force stop discards the PCM file.
- ffmpeg is probed at start, so a host without it is refused before anything is captured.
- Segmented Android recordings (over 180 s) refuse `audio`: the track would need stitching across
  segments.

## Discovery and auth

- The emulator writes `pid_<pid>.ini` under `<dir>/avd/running`, where `<dir>` is
  `~/Library/Caches/TemporaryItems` on macOS, `$XDG_RUNTIME_DIR` (else `/tmp/android-<user>`)
  on Linux, and the temp dir. These are the same directories the AVD launch guard reads.
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
