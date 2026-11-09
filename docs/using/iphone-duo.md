# iPhone Duo simulator

The iPhone Duo simulator has two panels: a cover screen when folded and an inner screen when
opened. Switch between them with `setPosture` (for example `posture: "opened"`); `observe` then
reports the active panel.

## Home-screen icons after an unfold

After an unfold, the home screen reports app icon positions that do not match what is drawn. As a
result, `observe` on the home screen can omit icons that are visible (for example Settings) or
report an icon at the wrong position, and `tapOn` by an icon's label can fail with "Element not
found" or tap the wrong place. This affects app icons only; the dock, status bar and other
home-screen controls are reported correctly.

To open an app on the iPhone Duo, call `launchApp` with its bundle ID instead of tapping its
home-screen icon:

```json
{ "name": "launchApp", "arguments": { "appId": "com.apple.Preferences", "platform": "ios" } }
```

## Screenshots that cannot be verified

When AutoMobile cannot tell which panel is active, or cannot read the size of the fallback
screenshot to check it against the active panel, it does not return a screenshot that may be of
the dark panel. The screenshot fails with `Runner screenshot could not be verified`. Call `observe`
again so the active panel is known, or check the posture with `setPosture`.
