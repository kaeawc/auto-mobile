# iOS Simulator audio loopback

`injectAudioInput` reaches an iOS Simulator through the Mac's CoreAudio loopback devices (#13628).
`captureAudio` and recordings with audio tap the simulator's own processes (#19046), falling back to
the loopback output (#13629). The emulator route is in
[Emulator gRPC audio](../android/emulator-grpc-audio.md).

## Route

- A simulator records from the host default input and plays to the host default output.
- Every process inside a booted simulator descends from that device's `launchd_sim` and is an
  ordinary client of the host's `coreaudiod`. Capture taps those clients with a Core Audio process
  tap (public, macOS 14.2+), so it hears exactly that simulator and needs no driver. The daemon
  finds the `launchd_sim` PID with `pgrep` on the device's bootstrap plist path.
- Injection plays into the default input device's output side. The fallback capture reads the
  default output device's input side.
- Those two need a loopback device: a virtual transport, or a known loopback driver name (BlackHole,
  Loopback, Soundflower, VB-Cable, Background Music), with streams in both directions. A duplex
  headset has both directions but routes neither into the other, so it is refused. This is the
  same rule the capability inventory uses for `audioOutputCapture`.
- The helper resolves both devices by UID at each call, never by a cached numeric device id, since
  ids change across HAL restarts.

## Helper

`ios/audio-loopback` builds `audio-loopback-helper`, a Swift CLI over AudioQueue. The daemon resolves its signed, notarized universal release archive through
`AudioLoopbackHelperProvider`, verifies the pinned SHA-256 and caches the executable.
`AUTOMOBILE_IOS_AUDIO_LOOPBACK_HELPER` takes precedence as a local path override.
An unknown checksum disables release resolution.

- `play --sample-rate N`: reads 16-bit little-endian mono PCM from stdin into the injection device.
  It reads one 50 ms buffer each time the queue frees one, so the daemon's writes are paced by
  real-time playback. EOF drains the queue and exits 0. `SIGTERM` stops playback at once.
- `capture --duration-ms N --sample-rate N`: writes the same format to stdout and exits 0 after
  the duration. Reading an input device needs Microphone permission for the helper's process.
- `tap --launchd-pid N (--duration-ms N | --until-stopped) [--sample-rate N] [--mute]`: the same
  output as `capture`, from a process tap over the Core Audio clients descending from that
  `launchd_sim`. The daemon uses it whenever it knows the PID. With `--mute` the simulator is silent
  on the host while the tap runs.
- `capture --until-stopped --sample-rate N`: the same, until stdin closes; the helper then writes
  its last buffer and exits 0. Recordings with audio use this. The capture counts as complete only
  on exit 0 with stdout closed within 1 s. The tool sends `SIGTERM` to a helper still running 2 s
  after stdin closes. That signal, a crash, or a pipe left open fails the capture, so its tail is
  never silently lost. Neither deadline counts time the recording is still writing earlier audio to disk, since a
  helper whose stdout is not being read cannot finish.
- Stderr carries one marker per line: `audio-loopback-ready: <device name>` once the device is
  open, or `audio-loopback-error: <code> <message>` before a non-zero exit. A tap's ready line
  names its client count and the System Audio Recording preflight state; other lines are logged at
  debug level.

| Helper code          | Tool error                    |
| -------------------- | ----------------------------- |
| `no_loopback_input`  | `audio_injection_unsupported` |
| `no_loopback_output` | `audio_capture_unsupported`   |
| `no_simulator`       | `audio_capture_unsupported`   |
| anything else        | `audio_loopback_failed`       |

A released helper older than `tap` exits with `usage`; the daemon then retries with `capture` and
reports `route: host-loopback`.

## Process tap

- A running tap's process list cannot change, so the helper rebuilds the tap and its private
  aggregate device when the client set changes. Clients are keyed by process object and PID,
  because the HAL reuses an object ID for a later process. A HAL listener on the process object list
  triggers the check, and a 500 ms re-check backs it up.
- The IOProc runs on its own queue and hands mono copies to the state queue. Stopping an aggregate
  waits for a running IOProc, so one shared serial queue would deadlock a rebuild.
- A tap delivers frames only while a tapped process is playing. Once nothing has arrived for
  150 ms, the helper pads silence up to the wall clock, so a capture has its full duration. The
  delivery time is stamped in the IOProc, so a stdout write blocked on the daemon is not taken for
  a quiet device.
- The tap's float frames are mixed to mono and linearly resampled to the requested rate.
- The tap needs System Audio Recording permission for the responsible app of the helper's process;
  without it the tap delivers silence. The preflight can read `undetermined` while capture works.

The daemon waits up to 5 s for the ready marker before it kills the helper. A daemon crash closes
the helper's stdin, so `play` drains and exits on its own; `capture` ends at its duration. No
helper outlives its call by more than that.

## Isolation

The default devices are shared by every simulator on the host, and one `SimAudioProcessorService`
serves all of them, so there is no per-simulator separation on this route.

- The service allows one host-loopback injection at a time; a second start, including one racing
  the first's start, is `audio_injection_busy`.
- A process-tap capture hears only its simulator. A fallback loopback capture hears every simulator
  on the host.

Per-simulator injection needs a device per simulator, pinned through CoreSimulator's per-device
audio routing (#13631-#13633). That is not built yet; the routing interfaces, their measured
behavior and failure modes are in [iOS Simulator audio isolation](simulator-audio-isolation.md).

The choice of process taps is recorded in
[Driverless simulator audio capture](../../../devlog/2026-11-23-driverless-simulator-audio-capture.md).
