Android raw observe captures -- CtrlProxy prototype overlay windows over the Playground app (manual test 0.0.83..main, lane aovl, base main 60961a0fc)
Date: 2026-10-08

Device: emulator-5600 (AVD am-api36-ga-arm64, API 36, 1080x2400). CtrlProxy APK 0.0.83-SNAPSHOT (advertises overlay_window_metadata_v1).
Daemon: private lane daemon (main build). Each file is a byte-for-byte copy (cmp-verified) of the tool_outputs artifact the daemon
wrote for `observe {"raw":true}`. Nothing was trimmed or edited. rawViewHierarchy.json is CtrlProxy's unfiltered wire JSON
(disableAllFiltering, so no cross-window occlusion pass); viewHierarchy is the ordinary filtered capture.

app-layer-overlay-over-playground.raw.json
  prototype show {window:{layer:"app", persistence:"device", placement floating center}} with a "Bump" text (testTag bump).
  Windows: 174 CtrlProxy, type 3 (TYPE_SYSTEM = TYPE_APPLICATION_OVERLAY), [370,1063,710,1337], NO overlayPlacement/overlayOpaque;
           157 SystemUI status bar, type 3; 150 Playground application window, type 1 (active, focused).

floating-overlay-over-button-elevated.raw.json
  prototype show {window:{placement floating topStart offset (200,596)}} with a 185x60 dp box (testTag coverBox, #CCCC0000)
  over the Playground "Elevated" button.
  Windows: 170 CtrlProxy, type 4 (accessibility overlay), [525,1565,1011,1723], overlayPlacement floating, overlayOpaque false;
           157 SystemUI status bar, type 3; 150 Playground application window, type 1.
  button_elevated [550,1589,996,1715] is in rawViewHierarchy but absent from viewHierarchy: the device's cross-window
  occlusion pass removed it as hidden under the overlay window.
