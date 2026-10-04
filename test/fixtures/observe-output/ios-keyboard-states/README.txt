iOS raw hierarchy captures -- manual-test batch 8 (kaeawc/auto-mobile main cb7f7ad02)
Date: 2026-10-03 (UTC times below)

Device: iPhone 18 Pro simulator, UDID 2300914A-231E-4874-8F8A-40C3D2F1E24B, iOS 27.0 (24A434), 402x874 pt, booted headless (simctl boot; no Simulator.app window).
Runner: CtrlProxy iOS runner built from source at b27fc1c55 (ios/ unchanged through cb7f7ad02), local-build mode, runner SHA256 f01cca3a6194a2e29ba47ef4f3b42c36ff8ab72e4492beb3b025434ca0433943.
Daemon: private daemon from dist built at cb7f7ad02 (build id 7361caa32497d52f), flags --debug --embedded-sdk.
Simulator keyboard prefs in both states (com.apple.keyboard.preferences): AutomaticMinimizationEnabled = 1, HardwareKeyboardLastSeen = 1. They were not changed in this batch.

Payloads are byte-for-byte copies (cmp-verified) of the file the daemon wrote for the tool call
  observe {"platform":"ios","raw":true,"sessionUuid":"2e635b50-ce24-48bc-b7f4-f41a60346d66"}
(the MCP result is {"artifact":{"path":...,"payload":"ObserveResult"}}; the artifact file is the complete ObserveResult, including viewHierarchy and rawViewHierarchy). Nothing was trimmed or edited.

1) ios-keyboard-visible.raw.json (514072 bytes)
   App/screen: Playground (dev.jasonpearson.automobile.Playground) > Demos > Forms & Input ("Forms"). Email UITextField focused (value "mt8@example.com"), software keyboard on screen.
   State reached by: setUIState filling Name/Email on that screen (no pref change needed).
   Hierarchy captured 19:45:33.954Z (freshness.ageMs 119). UIKeyboard bounds [0,590,402,816] (on screen).
   keyboard {"action":"detect","platform":"ios"} immediately before and after the observe: {"success":true,"open":true,"message":"Keyboard is open"}
   Screenshot (simctl io screenshot, taken right after): ios-keyboard-visible.screenshot.png

2) ios-keyboard-minimized.raw.json (580481 bytes)
   App/screen: Playground > Settings tab. "Display Name" UITextField focused (value "AB Z1 K1 EN9 EN9"), software keyboard minimized off screen.
   State reached by: launchApp coldBoot, tapOn "Settings", tapOn "Display Name" (keyboard on screen), then a hardware key chord
     sendKeys {"commands":[{"action":"key","key":"arrow_right","modifiers":["meta"]}],"platform":"ios"}
   Timeline (UTC): 19:51:25.110 sendKeys request; 19:51:25.909 hierarchy captured (this payload's updatedAt; freshness.ageMs 815 when served);
     19:51:26.042 keyboard detect -> {"success":true,"open":true,"message":"Keyboard is open"};
     ~19:51:26.3-26.6 screenshot ios-keyboard-minimized.screenshot.png shows NO keyboard on screen;
     19:51:26.6 observe raw:true returned this payload; 19:51:27.116 keyboard detect -> open:true again;
     19:51:27.6 screenshot ios-keyboard-minimized.1s-later-keyboard-returned.screenshot.png shows the keyboard back on screen.
   UIKeyboard bounds in the payload: [0,918,402,1144] (below the 874 pt screen) -- the issue #9083 state.
   CAVEAT: in this session the minimized state was TRANSIENT. The keyboard slid off screen for roughly 1-1.5 s after each hardware
   key chord and then came back by itself (checked with screenshots every ~0.9 s). Batch 7 saw it stay minimized. Plain sendKeys
   type (xcuiTypeText), an unmodified arrow key, and volume buttons did not minimize it here; meta/shift chords did (8 of 10 tries;
   two chords had no effect and left the keyboard up). An observe made more than ~1.5 s after the chord returns the keyboard at [0,590,402,816].

`keyboard detect` output was identical in both states: {"success":true,"open":true,"message":"Keyboard is open"}.
