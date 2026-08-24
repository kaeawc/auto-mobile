# accessibilityFocus

<kbd>✅ Implemented</kbd> · <kbd>🧪 Tested</kbd> · <kbd>🤖 Android Only</kbd>

> **Current state:** The `accessibilityFocus` MCP tool sets or clears the Android
> TalkBack accessibility-focus cursor on a chosen element. iOS VoiceOver focus has no
> backend wired, so the tool errors clearly on iOS rather than no-op'ing. See the
> [Status Glossary](../../status-glossary.md) for chip definitions.

For the overall accessibility adaptation design see
[TalkBack/VoiceOver Adaptation](../../mcp/a11y/talkback-voiceover.md) and the
[Accessibility overview](../../mcp/a11y/index.md). This document covers the
explicit focus-control tool.

## Goal

Deliberately place or clear the **TalkBack accessibility-focus cursor** (the green
focus rectangle, distinct from input focus) on a chosen element. This is the _write_
counterpart to the already-shipping `requestCurrentFocus` / `requestTraversalOrder`
read paths and is a building block for accessibility audits and deterministic
TalkBack navigation.

## MCP tool

```typescript
accessibilityFocus({
  action?: "set" | "clear",   // defaults to "set"
  resourceId?: string,        // e.g. "com.example:id/title"
  text?: string,              // resolved to a resource-id via the element finder
  contentDesc?: string        // resolved to a resource-id via the element finder
})
// → { success: boolean, focusedElement?: Element, error?: string }
```

Provide exactly one selector. `text` / `contentDesc` selectors are resolved to a
`resource-id` against the current view hierarchy before the action is sent, because
the accessibility service resolves nodes by `resource-id`. If the matched element has
no `resource-id`, the tool returns a structured error.

## How it works

The CtrlProxy `AccessibilityService` already exposes both operations as named actions
over the WebSocket `request_action` protocol
(`android/control-proxy/.../CtrlProxy.kt`, `performNodeAction`):

- `"focus"` → `AccessibilityNodeInfo.performAction(ACTION_ACCESSIBILITY_FOCUS)`
- `"clear_focus"` → `AccessibilityNodeInfo.performAction(ACTION_CLEAR_ACCESSIBILITY_FOCUS)`

The service resolves the node by `resource-id` (`findNodeByResourceId`) and broadcasts
an `action_result`. The TypeScript path:

1. `accessibilityFocus` tool (`src/server/accessibilityFocusTools.ts`) gates iOS and
   delegates to the `SetAccessibilityFocus` feature.
2. `SetAccessibilityFocus` (`src/features/accessibility/SetAccessibilityFocus.ts`)
   resolves the selector to a `resource-id`, calls
   `AndroidCtrlProxyClient.setAccessibilityFocus` / `clearAccessibilityFocus`, then
   confirms the cursor moved via `requestCurrentFocus` (best-effort).
3. `CtrlProxyFocus` (`src/features/observe/android/CtrlProxyFocus.ts`) sends
   `{ type: "request_action", action: "focus" | "clear_focus", resourceId }` and awaits
   the `action_result`.

This mirrors the already-shipping focus-set in
`ScrollUntilVisible.setAccessibilityFocusOnElement()`, which proves the path works
end to end.

## Platform support

| Platform | Screen Reader | Status                                                                   |
| -------- | ------------- | ------------------------------------------------------------------------ |
| Android  | TalkBack      | <kbd>✅ Implemented</kbd>                                                |
| iOS      | VoiceOver     | <kbd>❌ Not Implemented</kbd> — tool errors with an Android-only message |

## Manual test plan

Prereqs: an Android emulator/device with the AutoMobile CtrlProxy accessibility
service installed and enabled, TalkBack on (so the cursor is observable), and a
foreground app with at least two elements that have resource-ids.

1. Find a target resource-id:
   `adb shell uiautomator dump /sdcard/win.xml && adb pull /sdcard/win.xml -`
2. Set focus by resource-id:
   `{ "action": "set", "selector": { "resourceId": "com.example:id/title" } }` —
   expect `{ "success": true, "focusedElement": { ... } }` and the green focus
   rectangle on that element.
3. Confirm via `observe` / `requestCurrentFocus` — `focusedElement` matches the target.
4. Set focus by text (resolution path): `{ "action": "set", "text": "Settings" }`.
5. Clear focus: `{ "action": "clear", "resourceId": "com.example:id/title" }` —
   expect `{ "success": true }`; the focus rectangle disappears.
6. Error path — bad id:
   `{ "action": "set", "resourceId": "com.example:id/does_not_exist" }` — expect a
   structured error `Element not found with resource-id: ...`.
7. iOS gating — run against a booted simulator and expect an `ActionableError` stating
   the tool is Android-only.
