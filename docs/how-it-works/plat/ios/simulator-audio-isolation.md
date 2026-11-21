# iOS Simulator audio isolation

Per-simulator audio routing behind `injectAudioInput` and `captureAudio` (#13632). The shared route
is in [iOS Simulator audio loopback](simulator-audio-loopback.md). This page covers the routing API
that could separate two concurrent simulators and what a headless host constrains. Today one
loopback pair is the host default and one audio test runs at a time per host; the
[decision record](../../../devlog/2026-11-19-ios-simulator-audio-isolation.md) holds the options.

## Per-simulator routing

Each booted simulator keeps its own route in
`<device>/data/var/run/com.apple.coresimulator.audio.plist`: `sim_input_device_uid`,
`sim_output_device_uid`, `useHostDefaultInputDevice`, `useHostDefaultOutputDevice`.
`simulatoraudio/audiosettings.plist` mirrors the UIDs plus volume and ringer state, with no "use
host default" flag. Pinning one simulator leaves the others at the host default. Device UIDs are
the CoreAudio `kAudioDevicePropertyDeviceUID` strings (for example `BlackHole2ch_UID`). There is no
`simctl` or `defaults` audio verb.

### Routing interfaces

Two private interfaces route a booted simulator from a plain process with no `Simulator.app`. Both
take scope `1` for the guest's input and `2` for its output. They were measured on different hosts
and runtimes, and they disagree on whether a pin outlives the client that made it:

|                             | `SimDeviceAudioClient` (SimulatorKit)                                                                                            | `SimAudioHostRoutable` (CoreSimulator IO port)                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Measured on                 | Xcode 26.6, macOS 26.6.2, iOS 27.0 runtime                                                                                       | CoreSimulator 1174.9.2, iOS 26.5 runtime                                                                           |
| Reached through             | `SimServiceContext` -> default device set -> `devicesByUDID`, then `initWithDevice:eventHandlerQueue:error:changedEventHandler:` | `SimDevice.io.ioPorts`                                                                                             |
| Route                       | `routeGuestWithScope:to:completionQueue:completionHandler:` (`to:` is a UID string)                                              | `routeGuestDeviceScope:toHostDeviceUID:completionQueue:completionHandler:`                                         |
| Read back                   | `currentState.selected{Input,Output}Device` `uniqueIdentifier`; `changedEventHandler` fires once per change                      | `guestInputHostDeviceUID`, `guestOutputHostDeviceUID` (`__sim__hostUseSystemDefaultDeviceUID` is the host default) |
| Host devices                | `currentState.inputDevices`, `outputDevices`                                                                                     | `availableHostDevices`, `effectiveDefault{Input,Output}DeviceUID`                                                  |
| Unknown UID                 | completes with no error; state and plist unchanged                                                                               | accepted with no error; falls back to the effective default                                                        |
| Pin seen by a later process | yes, and the plist flag is updated before the next read                                                                          | no: a second process reads the host default, and the plist changed in one of several attempts                      |
| Survives a simulator reboot | not measured                                                                                                                     | no                                                                                                                 |

Settling which persistence result holds needs both interfaces run against the same simulator on one
host and runtime, read back from a second process and again after a reboot.

### Failure modes

No rejected route fails loudly, and nothing relevant is logged at the default level.

- Editing the plist while the simulator is shut down does not pin it; the service rewrites the plist
  at boot. An unknown UID is replaced by the host default UID while `useHostDefault*Device` stays
  `false`. A device the router rejects (BlackHole 2ch) resets the whole plist to the built-ins with
  both flags back to `true`.
- Routing to the device that is already the default is accepted and leaves `useHostDefault*Device`
  `true`. A `nil` UID does not restore "use host default".
- A combined input+output virtual device (BlackHole 2ch) is listed in `SimDeviceAudioClient`'s
  `inputDevices` and `outputDevices` with `scope` 3 and `isDefaultInScopes` 0, and every route or
  pre-boot pin to it is dropped. Built-ins have scope 1 (input) or 2 (output). That the router
  accepts only a device whose scope equals the requested scope is a hypothesis; it needs an
  input-only or output-only virtual device to confirm.

So a `false` "use host default" flag does not prove the pin held. Validate the UID against the host
device list before routing, route after every boot from a long-lived client (the daemon), and
compare the read-back UID to the requested one.

Not measured: two simulators pinned to two different non-default devices (needs a second host input
or a single-scope virtual device), whether a pin survives a `coreaudiod` restart (needs sudo and
interrupts every booted simulator), and whether the guest hears the pinned device (needs an
in-simulator audio client).

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
