# iOS Simulator Dynamic Island and backlight

`displayConfig` hides or shows the Dynamic Island (`dynamicIsland`) and turns the display off or
on (`backlight`) on an iOS Simulator. simctl exposes neither. Background:
[devlog entry](../../../devlog/2026-11-23-simulator-island-and-backlight.md).

## Dynamic Island

`-[SimDevice setDynamicIslandSuppressed:error:]` has CoreSimulatorBridge write the SpringBoard
default `com.apple.springboard SBSuppressDynamicIslandCompletely`. SpringBoard observes that
default and takes or releases a SystemAperture suppression assertion, so AutoMobile writes the
default directly:

| Request   | Command                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| `hidden`  | `simctl spawn <udid> defaults write com.apple.springboard SBSuppressDynamicIslandCompletely -bool YES`         |
| `visible` | `simctl spawn <udid> defaults delete com.apple.springboard SBSuppressDynamicIslandCompletely`                  |
| read      | `simctl spawn <udid> defaults read com.apple.springboard SBSuppressDynamicIslandCompletely` (unset is visible) |

The default persists across reboots. Device types whose `capabilities.plist` sets
`DeviceSupportsDynamicIsland` change: iPhone 14 Pro and Pro Max, every iPhone 15, 16, 17 and
18 model except the 16e and 17e, iPhone Air and iPhone Duo. On other device types the write
succeeds and changes nothing. `simctl io screenshot` never includes the island, so screenshots
look the same either way.

## Backlight

`-[SimDevice setDisplayBacklightActive:error:]` has no defaults or simctl equivalent. A short
`osascript -l JavaScript` run loads `CoreSimulator.framework`, resolves the device through
`SimServiceContext` (developer directory from `DEVELOPER_DIR`, else the `xcode-select` link) and
calls it, so the private framework never loads into the daemon. Source:
`src/utils/ios-cmdline-tools/SimulatorBacklight.ts`.

SpringBoard handles off as a `SimulatorSetBacklightInactive` event: the display goes to the Lock
Screen in the always-on state on device types that have it, and the device locks. On is a
`SimulatorSetBacklightActive` event that lights the Lock Screen; it does not unlock. The state is
read from `notifyutil -g com.apple.springboard.hasBlankedScreen` (1 is off). Off takes about a
second to report, so a write polls the read every 250 ms, at most 12 times.

## Reset

`displayConfig reset` deletes the island default when it reads as hidden and turns the backlight
on when it reads as off; a Simulator already in that state gets no command.

In a session, a displayConfig call that sets either field (or resets) journals a
`device-setting` row, `dynamicIsland` or `backlight`, with the prior read first. Keep-booted
reset writes the island default back (or deletes it when it was unset) and calls the backlight
bridge with the prior state.
