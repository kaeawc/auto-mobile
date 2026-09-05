# Accessibility-data-sensitive windows (Android 14+)

Issue #6151: `observe` returned only the `com.android.systemui` status bar — and
`tapOn` had nothing to hit — whenever a runtime permission dialog or the Settings
Wi-Fi picker was in front, while `uiautomator dump` at the same moment saw the
full window.

## Root cause

Android 14 added `View#setAccessibilityDataSensitive` /
`android:accessibilityDataSensitive`. Views marked sensitive (and the windows
built from them) are delivered only to accessibility services whose service
config declares `android:isAccessibilityTool="true"`. Every other service gets a
`null` root for that window: `AccessibilityWindowInfo.getRoot()` and
`rootInActiveWindow` both return `null`, even though the window is listed with
the correct `focused=true` / `active=true` flags. `uiautomator` is exempt because
`UiAutomation` is registered as an accessibility tool.

The permission controller's `GrantPermissionsActivity` and the Settings
`Settings$WifiSettingsActivity` panel are such surfaces on the API 34 GA image.
Ground truth captured on `am-api34-ga-arm64`:

```
$ adb shell dumpsys accessibility | grep A11yWindow
... id=219, type=TYPE_SYSTEM,      layer=1, bounds=Rect(0, 0 - 1080, 63),   focused=false, active=false ...
... id=256, type=TYPE_APPLICATION, layer=0, bounds=Rect(0, 0 - 1080, 2400), focused=true,  active=true ...

$ adb logcat -s ViewHierarchyExtractor
[HIERARCHY-DEBUG] Active window 256 has null root node - accessibility service incomplete
Occlusion filtering active: false (... windowCount=1)
```

The window flags were right and `pickPrimaryAppWindowId` selected window 256;
there was simply no content to extract. The same capture with the tool-declared
CtrlProxy build returns the Settings panel (14 text nodes) and, for a permission
dialog, the dialog buttons.

## Fix

- `android/control-proxy/src/main/res/xml/accessibility_service_config.xml`
  declares `android:isAccessibilityTool="true"`. The attribute is ignored on
  API < 33. This is the only change that recovers the content; no window-ranking
  rule can produce nodes the framework withholds.
- `ViewHierarchyExtractor` detects the notification-permission dialog in
  whichever window carries it (not only the primary window), and when no window
  reports focus at all, prefers the topmost application window with a root over
  a status bar that happens to be marked active.
- The host freshness verdict distinguishes an incomplete capture
  (`ctrlProxyIncomplete: true` — the service could not read the focused window)
  from a stale one, so the client is told to update CtrlProxy instead of pressing
  home / relaunching, which does not recover this shape.

## Play policy note

Declaring `isAccessibilityTool` is a framework capability, not a Play Store
entitlement. CtrlProxy is side-loaded onto test devices by AutoMobile and is not
distributed through Play, so the Play "accessibility tool" declaration review
does not apply.

## Verifying on a device

```
adb shell pm revoke com.android.camera2 android.permission.CAMERA
adb shell am start -n com.android.camera2/com.android.camera.CameraLauncher
# GrantPermissionsActivity is now in front
adb shell dumpsys accessibility | grep A11yWindow
```

Then `observe` must list the dialog's buttons ("While using the app", "Only
this time", "Don't allow") and `tapOn { selector: { text: "Don't allow" } }`
must succeed. Note the native fix is inert until the CtrlProxy APK the daemon
installs is re-cut with the new service config.
