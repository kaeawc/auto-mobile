# iOS Simulator keyboard

`setDeviceState keyboard` connects or disconnects a simulator's hardware keyboard and selects its
keyboard language. Source: `src/utils/ios/SimulatorKeyboardBridge.ts`,
`src/features/utility/device-state/KeyboardState.ts`.

## CoreSimulator calls

`simctl` has no verb for either setting. AutoMobile calls two `SimDevice` methods in the system
CoreSimulator framework, the ones Simulator.app uses:

| Call                                                            | Effect                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setHardwareKeyboardEnabled:(BOOL) keyboardType:(uint8) error:` | Disconnected, a focused text field shows the software keyboard, even after hardware key events. Connected, iOS hides the software keyboard after the first hardware key event. A field that is already focused keeps its keyboard until it is focused again.          |
| `setKeyboardLanguage:(NSString *) error:`                       | Appends the input mode to `AppleKeyboards` (for example `fr_FR` adds `fr_FR@sw=AZERTY-French;hw=Automatic`), sets it as `KeyboardLastUsed`, and appends the language to `AppleLanguages`. The software and hardware keyboards use the new layout from the next focus. |

`keyboardType` is the Apple keyboard type code: 204 ANSI, 205 ISO, 206 JIS. Simulator.app derives
it from the host keyboard through SimulatorKit's `IndigoHIDGetKeyboardType`. `setKeyboardLanguage`
accepts a keyboard identifier before the `@` (`en_US`, `fr`, `ja_JP`, `ja_JP-Kana`,
`zh_Hans-Pinyin`) and returns NO for one the runtime has no keyboard for (`en-GB`, `zz`).

The call runs in `osascript -l JavaScript` (JXA), which loads
`/Library/Developer/PrivateFrameworks/CoreSimulator.framework`, gets
`SimServiceContext sharedServiceContextForDeveloperDir:error:` for `DEVELOPER_DIR` (else the
`xcode-select` link), and finds the booted device by UDID. It passes `null` for the error
out-parameter: the JXA bridge crashes boxing the returned `NSError`. A separate process keeps the
private framework and any crash out of the daemon, and needs no build step.

## Read-back and restore

Neither setting has a read-back, so the result never reports `verified`.

- Every boot connects the hardware keyboard and nothing persists the setting. The journal records
  the boot state (connected, ANSI) as the prior, and keep-booted reset connects it again.
- The journal records `AppleKeyboards`, `AppleLanguages` and `AppleLocale` from
  `.GlobalPreferences` and `KeyboardLastUsed` from `com.apple.keyboard.preferences`, read with
  `simctl spawn defaults`; an unset key is recorded as null (a new simulator has no
  `AppleKeyboards` or `KeyboardLastUsed`). Reset first calls `setKeyboardLanguage` with the prior
  selection, else the first language keyboard, else the locale: the running keyboard ignores a
  `defaults` write of the selection alone. It then writes the three keys back, or deletes the
  unset ones. `AppleKeyboardsExpanded`, which the language call sets to 1, is not restored.

A failed restore call fails the revert, so keep-booted reset escalates. See
[Keyboard control through CoreSimulator](../../../devlog/2026-11-23-simulator-keyboard-coresimulator.md).
