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

The default persists across reboots. Only device types whose `capabilities.plist` sets
`DeviceSupportsDynamicIsland` have an island: iPhone 14 Pro and Pro Max, every iPhone 15, 16, 17
and 18 model except the 16e and 17e, iPhone Air and iPhone Duo. AutoMobile reads that capability
through the CoreSimulator bridge (see Backlight) once per UDID. On other device types it reports
`supported.dynamicIsland: false`, omits the island from reads, skips it on reset, and refuses a
`dynamicIsland` request before any field of the request runs. An unreadable capability counts as
supported.

`simctl io recordVideo` frames and the Simulator window show the island, and a hidden island is
gone from both. `simctl io screenshot` never includes the island. It suppresses the island while
it captures and then writes the default back to NO, which shows a hidden island again. For the
daemon's lifetime, AutoMobile records each Simulator whose island it hid and read back as hidden.
It writes the default back after each of its own simctl screenshots. A write still running after
5 s is killed. A screenshot taken outside AutoMobile, or after a
daemon restart, still shows the island until the next `dynamicIsland: "hidden"`.

## Backlight

`-[SimDevice setDisplayBacklightActive:error:]` has no defaults or simctl equivalent. A short
`osascript -l JavaScript` run loads `CoreSimulator.framework`, resolves the device through
`SimServiceContext` and calls it, so the private framework never loads into the daemon. The
developer directory is `DEVELOPER_DIR` (an `.app` path means its `Contents/Developer`), else the
`xcode-select` link. The script prints JSON: `{"ok":…}`, or an error code for an unloadable
framework, an unknown UDID or a device that is not booted. It passes null for every NSError
out-parameter: boxing the NSError of a failed call crashes osascript with SIGSEGV. Source:
`src/utils/ios-cmdline-tools/SimulatorBacklight.ts`.

SpringBoard handles off as a `SimulatorSetBacklightInactive` event: the display goes to the Lock
Screen in the always-on state on device types that have it, and the device locks. On is a
`SimulatorSetBacklightActive` event that lights the Lock Screen; it does not unlock. The state is
read from `notifyutil -g com.apple.springboard.hasBlankedScreen` (1 is off). Off takes about a
second to report, so a write polls the read every 250 ms, at most 12 times.

## Reset

`displayConfig reset` deletes the island default when it reads as hidden and turns the backlight
on when it reads as off; a Simulator already in that state gets no command.

In a session, a `displayConfig` call that sets either field (or resets) journals a
`device-setting` row, `dynamicIsland` or `backlight`, with the prior read first. Keep-booted
reset writes the island default back (or deletes it when it was unset) and calls the backlight
bridge with the prior state.
