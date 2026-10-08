iOS keyboard-mode captures for issue #9290 (keyboard focus with the keyboard outside the docked layout).
Date: 2026-10-08, 12:18Z (software-docked) and 12:18:54Z (hardware-keyboard).

Device: iPhone 17 simulator "Overlay Proto iPhone 17", UDID DFBF2D27-6674-42EA-AFC4-AB702275D1D4,
iOS 26.5 (23F77), 402x874 pt, Xcode 26.6 (17F113).
App: Playground (dev.jasonpearson.automobile.Playground) > Demos > Forms & Input. The Email UITextField
was tapped, gained keyboard focus, and received typeText("m9290@example.com").
Capturer: a temporary XCUITest in the CtrlProxyUITests bundle, built from main 2d1d0a12f with this
change applied, run with xcodebuild test-without-building on that simulator. Files are written
by the test as-is; nothing was trimmed or edited.

Per mode:
- <mode>.xcui-snapshot.json: XCUIApplication.snapshot() of the app, serialized node by node:
  elementType (XCUIElement.ElementType raw value), frame [x, y, width, height], hasFocus,
  hasKeyboardFocus (read from the captured snapshot by key-value coding; omitted if unreadable),
  identifier and label when non-empty, children. JSONSerialization, sorted keys, pretty-printed.
- <mode>.runner-hierarchy.json: ElementLocator.getViewHierarchy() for the same screen, encoded with
  JSONEncoder (sorted keys). The Email UITextField carries "focused":"true" in both.

Modes:
1) software-docked: hardware keyboard disconnected. UIKeyboard is in the app tree at [0, 583, 402, 233].
2) hardware-keyboard: hardware keyboard connected after the test session started, through
   CoreSimulator's -[SimDevice setHardwareKeyboardEnabled:YES keyboardType:0 error:] (what
   Simulator's I/O > Keyboard > Connect Hardware Keyboard calls). The software keyboard moves off
   screen and stays there: UIKeyboard is still in the app tree, at [0, 952, 402, 233], below the
   874 pt screen. XCTest disconnects the hardware keyboard when a UI-test session starts, so it must
   be connected after the runner is up.

In both modes: SpringBoard has no keyboard (springboard.keyboards.firstMatch.exists == false), the
Email field's public snapshot hasFocus is false, and its captured hasKeyboardFocus is true.
Not captured: a floating keyboard (iPhone has none) and the iPad floating or undocked keyboard,
which needs an iPad simulator.
