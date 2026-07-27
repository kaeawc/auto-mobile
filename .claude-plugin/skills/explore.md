---
description: Explore a mobile app, build a navigation graph, and reuse learned paths
allowed-tools: mcp__auto-mobile__observe, mcp__auto-mobile__tapOn, mcp__auto-mobile__swipeOn, mcp__auto-mobile__inputText, mcp__auto-mobile__clearText, mcp__auto-mobile__selectAllText, mcp__auto-mobile__pressButton, mcp__auto-mobile__pressKey, mcp__auto-mobile__dragAndDrop, mcp__auto-mobile__pinchOn, mcp__auto-mobile__keyboard, mcp__auto-mobile__imeAction, mcp__auto-mobile__homeScreen, mcp__auto-mobile__recentApps, mcp__auto-mobile__systemTray, mcp__auto-mobile__launchApp, mcp__auto-mobile__terminateApp, mcp__auto-mobile__openLink, mcp__auto-mobile__clipboard, mcp__auto-mobile__rotate, mcp__auto-mobile__shake, mcp__auto-mobile__deviceSnapshot, mcp__auto-mobile__installApp, mcp__auto-mobile__clearAppData, mcp__auto-mobile__explore, mcp__auto-mobile__getNavigationGraph, mcp__auto-mobile__navigateTo
---

Explore and interact with connected mobile devices. Use the navigation graph when an app benefits from repeatable discovery and learned-path replay.

## Getting Started

Use `observe` to capture the initial screen state when starting a session. Most interaction tools automatically return updated screen state, so you only need to call `observe` again if:
- Starting a new session or switching devices
- An action resulted in an incomplete or loading state
- You need to verify state after a delay or background process

## Available Skills

For detailed usage of specific capabilities, see these focused skills:

- `/apps` - Launch, terminate, and manage applications
- `/system` - Home screen, recent apps, hardware buttons, rotation
- `/notifications` - Interact with notification shade and alerts
- `/text` - Text input, keyboard control, clipboard operations
- `/gesture` - Tap, swipe, scroll, pinch, drag-and-drop
- `/snapshot` - Capture and restore device state

## Quick Reference

### App Management
```
launchApp with packageName: "com.example.app"
terminateApp with packageName: "com.example.app"
openLink with url: "https://example.com"
```

### System Navigation
```
homeScreen
recentApps
pressButton with button: "back"
rotate with orientation: "landscape"
```

### Notifications
```
systemTray with action: "open"
systemTray with action: "find", notification: {title: "Message"}
systemTray with action: "tap"
```

### Gestures
```
tapOn with text: "Submit"
tapOn with text: "Item", action: "longPress"
swipeOn with direction: "up"
swipeOn with direction: "up", lookFor: {text: "Settings"}
dragAndDrop with source: {text: "Item"}, target: {text: "Folder"}
pinchOn with direction: "out"
```

### Text Input
```
tapOn with text: "Email", action: "focus"
inputText with text: "user@example.com"
imeAction with action: "next"
clearText
selectAllText
clipboard with action: "paste"
```

### Device State
```
deviceSnapshot with action: "capture", snapshotName: "baseline"
deviceSnapshot with action: "restore", snapshotName: "baseline"
```

## Workflow

1. **Start** - Use `observe` to capture initial screen state
2. **Discover** - Run `explore` with a bounded `maxInteractions` to discover screens and transitions. Use `dryRun` when you only need the planned interactions.
3. **Inspect** - Call `getNavigationGraph` to review the learned screens, transitions, and current screen for this device session.
4. **Replay** - Use `navigateTo` with `targetScreen` when the graph already contains a route, then verify arrival with `observe`.
5. **Recover** - If replay or exploration reports a recovery failure, observe the current screen, use the platform-aware system controls, and fall back to deliberate step-by-step interaction rather than assuming a learned path still applies.

## Confidence and Platform Notes

- Navigation graphs are learned from observations, tool calls, and SDK navigation events. Treat a route as a useful hypothesis and verify important arrivals.
- SDK navigation events provide the strongest screen identity. Apps without them can have ambiguous, structurally similar screens.
- Android supports graph workflows on devices and emulators. iOS graph workflow support uses the XCUITest CtrlProxy runner on simulators.
- `explore` uses platform-aware back/home recovery. It reports an actionable failure instead of attempting Android shell recovery on iOS.

## Tips

- Use `homeScreen` to reset to a known starting point
- Use `lookFor` with swipe to find off-screen elements
- Use snapshots to speed up repetitive test setup
- Reference the focused skills for detailed parameter info
