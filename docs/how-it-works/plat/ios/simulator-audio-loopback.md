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

`ios/audio-loopback` builds `audio-loopback-helper`, a Swift CLI over AudioQueue. The daemon resolves its signed, notarized universal release archive through
`AudioLoopbackHelperProvider`, verifies the pinned SHA-256 and caches the executable.
`AUTOMOBILE_IOS_AUDIO_LOOPBACK_HELPER` takes precedence as a local path override.
An unknown checksum disables release resolution.

- `play --sample-rate N`: reads 16-bit little-endian mono PCM from stdin into the injection device.
  It reads one 50 ms buffer each time the queue frees one, so the daemon's writes are paced by
  real-time playback. EOF drains the queue and exits 0. `SIGTERM` stops playback at once.
- `capture --duration-ms N --sample-rate N`: writes the same format to stdout and exits 0 after
  the duration. Reading an input device needs Microphone permission for the helper's process.
- `capture --until-stopped --sample-rate N`: the same, until stdin closes; the helper then writes
  its last buffer and exits 0. Recordings with audio use this. The capture counts as complete only
  on exit 0 with stdout closed within 1 s. The tool sends `SIGTERM` to a helper still running 2 s
  after stdin closes. That signal, a crash, or a pipe left open fails the capture, so its tail is
  never silently lost. Neither deadline counts time the recording is still writing earlier audio to disk, since a
  helper whose stdout is not being read cannot finish.
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

## Per-simulator pinning

Measured on Xcode 26.6, macOS 26.6.2 and the iOS 27.0 runtime, headless (Simulator.app closed).

**Mechanisms**

- Each booted simulator keeps its own routing in `<device>/data/var/run/com.apple.coresimulator.audio.plist`:
  `sim_input_device_uid`, `sim_output_device_uid`, `useHostDefaultInputDevice`,
  `useHostDefaultOutputDevice`. `simulatoraudio/audiosettings.plist` mirrors the UIDs plus volume
  and ringer state, with no "use host default" flag. Pinning one simulator leaves the others at
  `true/true`.
- Post-boot, the private `SimulatorKit` `SimDeviceAudioClient.routeGuestWithScope:to:completionQueue:completionHandler:`
  works without Simulator.app for both scopes (`1` input, `2` output; `to:` is an NSString UID).
  `currentState` and the plist flag update before the next read, and `changedEventHandler` fires
  once per change. The client comes from `SimServiceContext` -> default device set -> `devicesByUDID`.
- There is no `simctl` or `defaults` audio verb.

**Silent failure modes (the pin is never rejected loudly)**

- A live route to an unknown UID: completion `error == nil`, state and plist unchanged.
- A pre-boot plist pin to an unknown UID: the UID is rewritten to the host default and
  `useHostDefault*` stays `false`.
- A pre-boot pin to a device the router rejects (BlackHole 2ch): the whole plist resets to the
  built-ins with both flags back to `true`.
- Nothing relevant is logged at default level.
- Routing to a device that is already the default is accepted and leaves `useHostDefault*=true`.
- A `nil` UID does not restore "use host default".

So `useDefault*Device == false` does not prove the pin held. Always compare
`selected{Input,Output}Device.uniqueIdentifier` to the requested UID.

**Loopback devices**

A combined input+output virtual device (BlackHole 2ch) is listed in `inputDevices` and
`outputDevices` with `scope` 3 and `isDefaultInScopes` 0, and every route or pre-boot pin to it is
dropped. Built-ins have scope 1 (input) or 2 (output). The working hypothesis is that the router
accepts only a device whose scope equals the requested scope; unconfirmed.

**Not answered**

- Two simulators on two different non-default devices: needs a second host input device or an
  input-only or output-only virtual device.
- Whether the pin survives a `coreaudiod` restart: needs sudo and interrupts every booted simulator.

**Recommendation**

Build post-boot `routeGuest` with mandatory read-back first: it confirms synchronously and needs no
shutdown, while the plist route gives no feedback. Treat the plist as a pre-boot hint. Do not rely on
combined-scope loopbacks for isolation until a scope-1 or scope-2 virtual device is shown to be
accepted.
