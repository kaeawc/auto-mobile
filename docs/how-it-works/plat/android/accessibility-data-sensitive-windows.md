# Accessibility-data-sensitive windows (Android 14+)

Android 14 added `View#setAccessibilityDataSensitive` / `android:accessibilityDataSensitive`.
Views marked sensitive, and windows built from them, are delivered only to accessibility services
whose config declares `android:isAccessibilityTool="true"`. Any other service gets a `null` root for
that window: `AccessibilityWindowInfo.getRoot()` and `rootInActiveWindow` both return `null`, even
though the window is listed with correct `focused=true` / `active=true` flags. `uiautomator` is exempt
because `UiAutomation` is registered as an accessibility tool.

On the API 34 GA image, the permission controller's `GrantPermissionsActivity` and the Settings
`Settings$WifiSettingsActivity` panel are such surfaces. Without the declaration, `observe` returns
only the `com.android.systemui` status bar while they are in front, and `tapOn` has nothing to hit.

## How CtrlProxy handles it

- `android/control-proxy/src/main/res/xml/accessibility_service_config.xml` declares
  `android:isAccessibilityTool="true"` (ignored below API 33). This is the only thing that recovers
  the content: no window-ranking rule can produce nodes the framework withholds.
- `ViewHierarchyExtractor` detects the notification-permission dialog in whichever window carries it,
  not only the primary window. When no window reports focus, it prefers the topmost application
  window with a root over a status bar marked active.
- The host freshness verdict reports an incomplete capture (`ctrlProxyIncomplete: true`: the service
  could not read the focused window) separately from a stale one, and tells the client to update
  CtrlProxy. Pressing home or relaunching does not recover this shape.
- The declaration takes effect only once the CtrlProxy APK the daemon installs carries the new
  service config.

`isAccessibilityTool` is a framework capability, not a Play Store entitlement. CtrlProxy is
side-loaded onto test devices and not distributed through Play, so Play's "accessibility tool"
declaration review does not apply.

## Verifying on a device

```
adb shell pm revoke com.android.camera2 android.permission.CAMERA
adb shell am start -n com.android.camera2/com.android.camera.CameraLauncher
# GrantPermissionsActivity is now in front
adb shell dumpsys accessibility | grep A11yWindow
```

`observe` must list the dialog's buttons ("While using the app", "Only this time", "Don't allow")
and `tapOn { selector: { text: "Don't allow" } }` must succeed.

## Background

- [Accessibility-data-sensitive windows: null roots on Android 14](../../../devlog/2026-09-05-accessibility-data-sensitive-windows-null-roots.md)
