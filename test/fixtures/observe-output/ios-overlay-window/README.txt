iOS raw hierarchy capture -- in-app overlay window prototype (worktree release-blocker-bugs-0082, base main 2a446a97e)
Date: 2026-10-07

Device: "Overlay Proto iPhone 17" simulator, UDID DFBF2D27-6674-42EA-AFC4-AB702275D1D4, iOS 26.5 (23F77), 402x874 pt, Simulator.app window visible.
Daemon: resident daemon (main build). The capture's rawViewHierarchy.xcuitest is the runner's unconverted XCTestHierarchy.

ios-floating-overlay-over-settings.raw.json is a byte-for-byte copy (cmp-verified) of the file the daemon wrote for
  observe {"platform":"ios","screenshot":"none","raw":true}
Nothing was trimmed or edited.

App/screen: Settings (com.apple.Preferences) root list, launched with the prototype overlay agent injected
(SIMCTL_CHILD_DYLD_INSERT_LIBRARIES=ios/overlay-agent build). A floating overlay (scripts/ios/overlay-agent-demo.ts floating,
gravity bottomCenter, offset 0) is shown in a second UIWindow at window level alert+1.
Raw windows under XCUIApplication, back to front:
  0  Settings app window: UINavigationBar [0,62,402,168], UIToolbar "Toolbar" [0,788,402,874]
  1  overlay window: floating-card [36,708,366,874], like-button and close-button [.., 780, .., 824] (inside the toolbar band),
     automobile-overlay-dismiss [350,62,394,106] (inside the navigation bar band)
Simulator appearance was dark at capture time.
