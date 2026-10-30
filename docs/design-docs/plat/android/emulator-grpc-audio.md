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

Each emulator has its own gRPC port, so two emulators cannot hear each other's audio. The emulator's
forwarder can still depend on host microphone voice initialization; guest recording alone does not
prove that voice is healthy. Host-mic passthrough (`-allow-host-audio`) is not used. A per-emulator
PulseAudio/PipeWire sink is a fallback that is only worth building if some supported environment
cannot reach the gRPC port.

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

- Before opening `injectAudio`, the host opens a CtrlProxy-owned guest microphone recording
  through an ordered broadcast: component
  `dev.jasonpearson.automobile.ctrlproxy/.GuestAudioCaptureReceiver`, action
  `dev.jasonpearson.automobile.GUEST_AUDIO_CAPTURE`, string extras `op` (`start`, `status`,
  `stop`) and `lease` (an injected host-generated id). The exported receiver requires
  `android.permission.DUMP`, which the adb shell holds and third-party apps do not. CtrlProxy
  requests `RECORD_AUDIO`; installation grants it for the setup user without an API-level gate.
- The process-wide controller holds at most one lease. `start` checks microphone permission,
  opens `AudioRecord` with MIC, mono S16 at 48 kHz and the platform minimum buffer size, and
  starts a background reader that continuously discards PCM. Repeating the held lease's start
  does not reopen it; a different lease is refused. The receiver sets result code 0 and a
  single-line result data: `running`, `stopped`, `absent`, or `failed <reason>` (quotes and
  CR/LF in reasons become spaces). Only the held lease may stop the recording. Stop is
  idempotent; status and stop for another lease return `absent`.
- A stopped record or read error releases the lease and reports `failed`; a read failure is
  retained until the owner's next status or stop, or a new start. A monotonic 30-minute
  timeout releases abandoned recordings and subsequent status returns `absent`. A CtrlProxy
  restart also loses the lease. No broadcast waits for PCM reads or joins the reader thread.
- The host requires `running` from start and every status poll (100 ms by default) throughout
  a three-second settle window, within an eight-second total deadline. Any other answer
  immediately refuses injection with `audio_guest_capture_unavailable`. Before guest capture and
  again before opening the gRPC session, injection also refuses captured host microphone failures
  with `audio_host_microphone_unavailable`, and a repeat injection in the same serial + discovered
  endpoint PID incarnation with `audio_repeat_injection_unsafe`. Both host safety errors carry
  `retryable: false` and a remedy to grant macOS Microphone permission to the emulator's host app
  (System Settings > Privacy and Security > Microphone) or restart the emulator. Permission alone
  does not clear repeat history: another injection requires a new emulator incarnation. No reliable
  positive host-voice success line is known, so repeats remain refused even after successful guest
  capture or a completed injection. Each broadcast uses
  no retries and at most two seconds of the remaining deadline. A missing receiver requires
  reinstalling CtrlProxy. Refusals include at most 2048 characters of the broadcast reply.
- The launcher indexes its existing redacted output snapshots by PID and serial for the process
  lifetime, including stdout and stderr after startup. The index holds at most 64 sources (oldest
  evicted) and removes a source on exit or close. Existing snapshots retain at most 50 lines /
  16,384 characters; audio lookups additionally cap the tail at 16 KiB of UTF-8. No extra log file
  is written. Host microphone failure (`Failed to create voice virtio-snd-mic0`,
  `Could not initialize record`, or `kAudioHardwareIllegalOperation`) is latched per incarnation
  at ingestion before tail trimming and stays refused until exit or source eviction.
  Emulators launched outside AutoMobile have no captured tail, so only the repeat rule applies.
- Injection history is local to the audio service lifetime and retains at most 128 serial + PID
  entries, evicting the oldest at capacity. An attempt is counted immediately before `injectAudio`,
  including attempts whose RPC fails, because it may already have opened a stream. Source or guest
  capture failures before that point do not count. A new PID permits a first injection; stopping an
  injection does not clear history. Service restarts and capacity eviction forget older history.
- Failure after start attempts best-effort stop with a separate two-second cleanup budget.
  Close runs once and accepts `stopped` or `absent`. Before cleanup the host verifies the
  emulator PID still matches its starting incarnation; otherwise it skips cleanup. Ownership
  is the lease plus the CtrlProxy process, so cleanup never signals a process or stops another
  lease's recording. AutoMobile does not enable adb root.
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
  `<recording>.audio.pcm`, so a long recording never sits in memory. Writes apply backpressure: when
  the file's buffer is full the sink returns a promise. The gRPC route then stops reading packets,
  and the call's message queue pauses the HTTP/2 stream at 64 queued messages (resuming at 16), so
  flow control holds the emulator. The loopback route pauses the helper's stdout. A stalled disk
  bounds memory instead of queueing audio. A silent guest sends no packets, so the gRPC route writes
  silence for the time between packets (from the packet timestamps, or arrival time when a timestamp
  is over 10 s from both the host clock and where the stream had reached, so audio that waited out a
  slow disk is not mistaken for silence) to keep the track in step with the video.
- At stop, after the video is final, it ends the capture and muxes with ffmpeg: video copied, audio
  AAC, the audio captured between the stream opening and the video launch skipped (`-ss`), and the
  track padded with silence to the video's length (`apad` + `-shortest`). An empty capture becomes
  `anullsrc`. The muxed file replaces the original.
- A failed capture or mux keeps the video, sets `hasAudioTrack: false` and adds a warning; a failed
  start or a force stop discards the PCM file. A `streamAudio` call that ends with a status other
  than OK or CANCELLED is a failed capture even after some audio arrived, and so is a PCM file
  write error (kept from the first failed write and raised at close). The PCM file is closed
  before it is removed on every path, including a failed audio stop.
- A force stop abandons the audio: chunks are dropped, a write waiting on a slow disk is released,
  and the video is torn down without waiting for the PCM file to close. One that arrives while the
  video is still finalizing does this right away; the pending stop then reports
  `hasAudioTrack: false`.
- A video stop that fails discards the audio. When the backend keeps the recording active for a
  retry (Android finalization), the retried stop reports `hasAudioTrack: false` with a warning; a
  force stop forgets that state.
- The start reports the PCM file as an in-progress sidecar, so the recording's in-progress size
  cap (`maxArchiveSizeMb`) counts it with the video file.
- The completed row stores `hasAudioTrack` and the stop's warnings (`has_audio_track`,
  `warnings_json`), so a stop that finds the recording already finalized (duration limit, repeated
  stop, daemon restart) returns what the finalizing stop produced. A recording that did not ask for
  audio stores null and reads with no `hasAudioTrack`.
- ffmpeg is probed at start, so a host without it is refused before anything is captured.
- Segmented Android recordings (over 180 s) refuse `audio`: the track would need stitching across
  segments. The tool refuses before planning segments, and the capture backend refuses again for a
  direct daemon start.

## Discovery and auth

- The launcher passes `-grpc <port>` to every emulator it spawns unless the arguments already
  carry `-grpc` or `-grpc=`. The port is leased from `EmulatorPortReservations`
  (`reserveEmulatorGrpcPort`) across 8554-8653: a port another launch holds, or one the host
  cannot bind, is skipped. The lease is released with the child's launch reservation on exit.
  Console and ADB ports (5554-5683) are outside that range.
- The emulator writes `pid_<pid>.ini` under `<dir>/avd/running`, where `<dir>` is
  `~/Library/Caches/TemporaryItems` on macOS, `$XDG_RUNTIME_DIR` (else `/tmp/android-<user>`)
  on Linux, and the temp dir. These are the same directories the AVD launch guard reads.
- The endpoint address comes from the file's `grpc.address` or `grpc.port`, which is the port the
  launcher passed. `localhost:8554` is the fallback for a file with neither key.
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
