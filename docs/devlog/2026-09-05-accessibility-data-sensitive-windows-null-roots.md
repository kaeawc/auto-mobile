# Accessibility-data-sensitive windows: null roots on Android 14

- Kind: decision
- Date: 2026-09-05
- Source: moved from `how-it-works/plat/android/accessibility-data-sensitive-windows.md`; #6151, #6170
- Shaped: [Accessibility-data-sensitive windows (Android 14+)](../how-it-works/plat/android/accessibility-data-sensitive-windows.md)

## Context

Issue #6151: `observe` returned only the `com.android.systemui` status bar, and `tapOn` had nothing
to hit, whenever a runtime permission dialog or the Settings Wi-Fi picker was in front, while
`uiautomator dump` at the same moment saw the full window.

Ground truth captured on `am-api34-ga-arm64`:

```
$ adb shell dumpsys accessibility | grep A11yWindow
... id=219, type=TYPE_SYSTEM,      layer=1, bounds=Rect(0, 0 - 1080, 63),   focused=false, active=false ...
... id=256, type=TYPE_APPLICATION, layer=0, bounds=Rect(0, 0 - 1080, 2400), focused=true,  active=true ...

$ adb logcat -s ViewHierarchyExtractor
[HIERARCHY-DEBUG] Active window 256 has null root node - accessibility service incomplete
Occlusion filtering active: false (... windowCount=1)
```

The window flags were right and `pickPrimaryAppWindowId` selected window 256; there was no content
to extract, because the framework withholds accessibility-data-sensitive windows from services that
do not declare `isAccessibilityTool`.

## Options

Not recorded.

## Decision

Declare `android:isAccessibilityTool="true"` in CtrlProxy's service config, improve window selection
in `ViewHierarchyExtractor`, and have the host freshness verdict report `ctrlProxyIncomplete`.

## Consequences

The same capture with the tool-declared CtrlProxy build returns the Settings panel (14 text nodes)
and, for a permission dialog, the dialog buttons.
