# Apple Watch evidence tools, and no side button yet

- Kind: decision
- Date: 2026-11-23
- Source: #19056
- Shaped: [Apple Watch tool behavior](../using/apple-watch-tools.md)

## Context

Apple TV simulators gained `videoRecording` and `compareScreenshot` through `simctl io recordVideo`
and `simctl io screenshot` (#16725). Apple Watch simulators had neither, and `executePlan` on a
watch recorded no video, so a watch run left no screen-level evidence. sim-rs drives watch
simulators directly (Digital Crown, side button, Double Tap and Wrist Flick through SimulatorKit
HID) and uses AutoMobile to check the screen afterwards. `pressButton` on a watch accepts only
`home`.

## Options

Evidence tools:

- Reuse the tvOS path: the iOS simulator `simctl io recordVideo` capture on simctl's default
  display, and a comparison screen that resolves regions from the runner hierarchy when a runner is
  connected.
- Leave both refused on watchOS.

Side button:

- The watch runner. `XCUIDevice.Button` lists `home`, `volumeUp`, `volumeDown` and `action` (the
  Apple Watch Ultra Action button) for watchOS in Apple's XCUIAutomation documentation, and no side
  button. The runner already maps `home` to `XCUIDevice.shared.press(.home)`.
- Simulator HID. SimulatorKit's `IndigoHIDMessageForButton(source, direction, target)` with
  source `0xbb8` and target `0x33`, sent through `SimDeviceLegacyHIDClient`, is how sim-rs presses
  the side button. AutoMobile's only HID client is the opt-in `carplay-power-helper`
  (`ios/carplay-power`), which users build themselves and point to with
  `AUTOMOBILE_CARPLAY_POWER_HELPER_PATH`.

## Decision

Both evidence tools join the watchOS allowlist through the tvOS paths. A recording uses simctl's
default display (a watch has one screen) and refuses audio. A comparison takes the same
`simctl io screenshot --display=<panel or main>` capture `observe` uses, since the watch runner
has no screenshot command. Without a runner, or when the runner's app is not in the foreground,
only the full screen compares. A watch plan records one video like tvOS.

The side button stays unsupported and is documented as a limit. The runner has no API for it, and
the HID path would make `pressButton` depend on a helper AutoMobile does not ship, built from
private SimulatorKit calls that only a macOS host with a watch simulator can check.

## Consequences

- `VideoRecordingPlatform`, `VisualPlatform` and stored baseline profiles include `watchos`.
  Shutdown stops a watch's active recordings before the simulator powers off.
- `videoRecording` and `compareScreenshot` advertise `watchos` in their input `platform` enum.
- Adding the side button later means shipping a simulator HID helper (or generalizing the CarPlay
  one) and verifying source `0xbb8` on a watch simulator before `pressButton` accepts it.
