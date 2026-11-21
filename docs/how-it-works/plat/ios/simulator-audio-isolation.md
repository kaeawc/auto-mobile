# iOS Simulator audio isolation

Per-simulator audio routing behind `injectAudioInput` and `captureAudio` (#13632). The shared route
is in [iOS Simulator audio loopback](simulator-audio-loopback.md). This page covers the routing API
that could separate two concurrent simulators and what a headless host constrains. Today one
loopback pair is the host default and one audio test runs at a time per host; the
[decision record](../../../devlog/2026-11-19-ios-simulator-audio-isolation.md) holds the options.

## Per-simulator routing

Each simulator's IO ports include an audio port that conforms to `SimAudioHostRoutable`. It is
reachable from a plain process through CoreSimulator's `SimDevice.io.ioPorts`, with no
`Simulator.app` and no GUI session. Its methods:

- `routeGuestDeviceScope:toHostDeviceUID:completionQueue:completionHandler:`, scope `1` for the
  guest's input and `2` for its output.
- `guestInputHostDeviceUID` and `guestOutputHostDeviceUID`; the value
  `__sim__hostUseSystemDefaultDeviceUID` means the host default.
- `availableHostDevices`, `effectiveDefaultInputDeviceUID`, `effectiveDefaultOutputDeviceUID`.

Device UIDs are the CoreAudio `kAudioDevicePropertyDeviceUID` strings (for example
`BlackHole2ch_UID`). The per-simulator state is
`<device>/data/var/run/com.apple.coresimulator.audio.plist` (`sim_input_device_uid`,
`useHostDefaultInputDevice` and the output pair). The service rewrites it at every boot, so editing
it while the simulator is shut down has no effect.

Observed on one simulator (iOS 26.5, CoreSimulator 1174.9.2):

- The route call completes with no error and the getter reports the new UID in the same process.
- A UID that names no host device is accepted without error and the simulator falls back to the
  effective default. Validate the UID against `availableHostDevices` before routing.
- A pin does not survive a simulator reboot; it must be re-applied after every boot.
- A second process reading `guestInputHostDeviceUID` sees the host default, and the plist changed
  in only one of several attempts, so the pin appears bound to the client that made it. Whether the
  guest hears the pinned device was not verified: it needs an in-simulator audio client.

A pin therefore needs a long-lived client (the daemon) that routes after each boot and keeps its
connection.

## Headless host constraints

- A per-slot design needs two loopback devices per simulator plus a silent default pair. One driver
  bundle runs one driver-service process (`Core Audio Driver (<name>.driver)` in `ps`), so publish
  all pairs from a single plug-in rather than one bundle per slot.
- A 16-channel device with per-slot channel pairs does not work: the routing API selects a device,
  never a channel map.
- Installing a HAL driver and restarting `coreaudiod` are system changes, so provisioning is an
  owner or image-build step, never a test step.
- An MDM profile cannot pre-grant the Microphone permission for the process that reads a loopback
  input, and no prompt can be answered without a GUI session. Capture of a loopback input by a
  LaunchDaemon-owned process is unmeasured.
- Sample rate is fixed per device; resample in the helper, not the device.
