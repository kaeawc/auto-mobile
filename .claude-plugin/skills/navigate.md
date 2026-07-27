---
description: Navigate to a screen using learned navigation paths
allowed-tools: mcp__auto-mobile__navigateTo, mcp__auto-mobile__getNavigationGraph, mcp__auto-mobile__explore, mcp__auto-mobile__observe, mcp__auto-mobile__launchApp, mcp__auto-mobile__homeScreen, mcp__auto-mobile__pressButton
---

Navigate to a target screen using the current device session's learned navigation graph, then verify that the app reached the intended state.

## Workflow

1. **Inspect the graph** - Call `getNavigationGraph` to see whether the target screen and a route to it are already known.
2. **Replay a known route** - Call `navigateTo` with `targetScreen`, then use `observe` to verify the expected screen or element.
3. **Discover a missing route** - Launch or reset the app to a known state, run a bounded `explore`, inspect the updated graph, and retry `navigateTo`.
4. **Recover deliberately** - If replay fails, observe the current state first. Use platform-aware back/home controls or step-by-step interactions; do not assume the recorded route still matches login, feature-flag, modal, or app-version state.

## Confidence and Platform Notes

- A navigation graph is learned evidence, not a guarantee. SDK navigation events provide the strongest screen identity; similar uninstrumented screens can be ambiguous.
- Verify critical arrivals with `observe`, especially when a route crosses authentication, modals, or dynamic content.
- Android supports graph workflows on devices and emulators. iOS graph workflow support uses the XCUITest CtrlProxy runner on simulators.
- Navigation recovery routes through platform-aware controls. Failures include platform context rather than falling back to Android shell commands on iOS.
