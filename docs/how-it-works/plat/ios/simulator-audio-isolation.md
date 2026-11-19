# iOS Simulator audio isolation

Per-simulator audio isolation for `injectAudioInput` and `captureAudio` (#13632). The shared route
is in [iOS Simulator audio loopback](simulator-audio-loopback.md); this note covers what separates
two concurrent simulators and what a headless host constrains.

## Options

1. **Serialize.** One loopback pair as the host default input and output; one audio test at a time
   per host. Needs no new code, and is the current behavior.
2. **Host defaults per slot.** Change the Mac's default devices before each test. This is a system
   setting shared by every simulator, so it cannot isolate concurrent runs and is rejected.
3. **Per-simulator pin.** Give each simulator its own input and output loopback device through
   CoreSimulator's per-device audio routing. This is the only option that isolates concurrent
   simulators.

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
connection. Confirm with an in-simulator recorder before building on it.

## Headless host constraints

- A per-slot design needs two loopback devices per simulator plus a silent default pair. One driver
  bundle runs one driver-service process (`Core Audio Driver (<name>.driver)` in `ps`), so publish
  all pairs from a single plug-in rather than one bundle per slot.
- A 16-channel device with per-slot channel pairs does not work: the routing API selects a device,
  never a channel map.
- Installing a HAL driver and restarting `coreaudiod` are system changes, so provisioning is an
  owner or image-build step, never a test step.
- The Microphone permission for the process that reads a loopback input cannot be pre-granted by
  an MDM profile, and no prompt can be answered without a GUI session. Capture of a loopback input
  by a LaunchDaemon-owned process is unmeasured.
- Sample rate is fixed per device; resample in the helper, not the device.

## Recommendation

Keep option 1 as the supported route. Pursue option 3 only after two measurements on a drained
host with two real loopback pairs: that the guest hears its pinned device while the other
simulator stays silent, and that a daemon-owned helper receives frames under the Microphone
permission. The `audio-loopback-helper` would then take explicit device UIDs instead of reading the
host defaults. If either fails, stay on option 1 and document it.
