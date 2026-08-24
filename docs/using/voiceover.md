# VoiceOver Testing

VoiceOver is iOS's built-in screen reader. When it is enabled, the navigation model, gesture set, and view hierarchy all change significantly. AutoMobile detects VoiceOver automatically and adapts its tool behavior so agents do not need to handle the difference explicitly.

For WCAG contrast and tap target auditing, see [Accessibility Analysis](./a11y.md).

---

## What Changes When VoiceOver Is Active

Understanding these differences helps explain why `observe` output may look different and why some element selectors need adjustment.

### Navigation and gesture model

VoiceOver takes over single-finger swipes for linear navigation through focusable elements (swipe right = next, swipe left = previous). A single tap moves the VoiceOver cursor to the tapped element and announces it; a double-tap activates the focused element. Three-finger swipes scroll content. Two-finger rotate activates the Rotor, a VoiceOver-specific navigation mode selector.

Because standard coordinate-based taps and single-finger swipes conflict with VoiceOver gestures, AutoMobile uses accessibility activation for supported taps. VoiceOver scrolling is currently unsupported because AutoMobile has no VoiceOver-aware scroll mechanism.

### View hierarchy differences

The accessibility tree that VoiceOver exposes can differ from the visual view hierarchy in three important ways:

**Element grouping.** When a parent container groups multiple children for accessibility, VoiceOver presents them as a single focusable element whose label combines the children's text. For example:

```
Visual hierarchy:
  UIView (tappable)
    UIImageView (icon)
    UILabel "Settings"
    UILabel "Manage app preferences"

Accessibility tree:
  UIView (accessible)
    accessibilityLabel: "Settings, Manage app preferences"
    [children excluded from accessibility tree]
```

If a selector targets `text: "Settings"` expecting to match the `UILabel` directly, it may not find it. Search instead for the grouped label on the parent, or use a substring that appears in the combined string.

**Decorative elements hidden.** Views with `isAccessibilityElement = false` (or `accessibilityElementsHidden = true` on a container) are excluded from the accessibility tree. `observe` returns fewer elements in VoiceOver mode, and visual-only selectors may fail. Use semantic selectors — `text`, `content-desc`, or `resource-id` — rather than layout position.

**Virtual nodes.** Some controls (such as sliders and page controls) expose accessibility nodes that do not correspond to real views. Coordinate-based taps can fail on virtual nodes; inspect the accessibility tree and use the control's supported semantic interaction.

---

## How AutoMobile Handles VoiceOver Automatically

AutoMobile queries `UIAccessibility.isVoiceOverRunning` via the CtrlProxy WebSocket when a device session starts and caches the result (refreshed every 60 seconds). When VoiceOver is detected, the following adaptations apply transparently:

| Tool                                      | Standard behavior        | VoiceOver behavior                                                               |
| ----------------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `tapOn`                                   | Coordinate-based tap     | Accessibility activation on the target element                                   |
| `swipeOn` / scroll                        | Single-finger swipe      | Unsupported; no VoiceOver-aware scroll mechanism or synthesized-gesture fallback |
| `inputText` / `clearText`                 | Text injection           | Text injection (unchanged)                                                       |
| `pressButton`                             | Device/navigation button | Device/navigation button (unchanged; see note below)                             |
| `launchApp`, `terminateApp`, `installApp` | Standard                 | Unchanged                                                                        |

No tool parameters change for supported interactions. Automation that scrolls while VoiceOver is active must use an app-specific navigation path or disable VoiceOver for that portion of the flow.

**Home button note.** When VoiceOver is active, the home button requires a single press to invoke rather than the swipe gesture used in standard navigation. AutoMobile handles this correctly with `pressButton({ button: "home" })`.

**Back navigation note.** iOS has no hardware back button. AutoMobile maps `pressButton({ button: "back" })` to app-level back navigation through CtrlProxy.

---

## Enabling VoiceOver on iOS Simulator

VoiceOver cannot be toggled programmatically via command-line tools on the iOS Simulator. Use one of the following methods:

**Via Simulator menu (fastest):**

```
Simulator > Features > Toggle VoiceOver
```

Or use the keyboard shortcut: **Option + Command + F5** (when the Simulator window is focused).

**Via Settings inside the Simulator:**

1. Open the Settings app in the Simulator.
2. Navigate to Accessibility > VoiceOver.
3. Toggle VoiceOver on or off.

**Via Accessibility Shortcut (after setup):**

If you configure the Accessibility Shortcut in Settings > Accessibility > Accessibility Shortcut, triple-pressing the Side Button or Home Button toggles VoiceOver.

> **Note:** After enabling VoiceOver in the Simulator, allow a moment for VoiceOver to initialize before issuing tool calls. VoiceOver plays an announcement sound when it starts. On physical devices, the same methods apply through Settings > Accessibility > VoiceOver, or by asking Siri to "Turn on VoiceOver."

---

## What `observe` Returns When VoiceOver Is Active

When VoiceOver is enabled, `observe` includes an additional field in its result:

**`accessibilityState`** — the current screen reader state:

```json
{
  "accessibilityState": {
    "enabled": true,
    "service": "voiceover"
  }
}
```

- `enabled`: `true` when VoiceOver is active.
- `service`: `"voiceover"` when VoiceOver is the active service, `"unknown"` for other accessibility services.

> **Note:** When the foreground app includes the AutoMobile iOS SDK, `observe` reports the VoiceOver cursor through `accessibilityFocusedElement`. The out-of-process CtrlProxy runner cannot read that cursor for apps without the SDK. See the [parity review](../design-docs/mcp/a11y/voiceover-talkback-parity.md) for details.

---

## Workflow: Testing an App Under VoiceOver

A typical VoiceOver test session follows this pattern:

**1. Enable VoiceOver.**

Use **Simulator > Features > Toggle VoiceOver** or the keyboard shortcut **Option + Command + F5**.

**2. Launch the app and observe initial state.**

```
observe()
```

Check that `accessibilityState.enabled` is `true` and `accessibilityState.service` is `"voiceover"`. Review the element tree — it will reflect the accessibility tree rather than the full visual hierarchy.

**3. Interact using standard tools.**

AutoMobile adapts internally. Write interactions the same way as without VoiceOver:

```
tapOn({ text: "Sign in" })
inputText({ text: "user@example.com" })
tapOn({ text: "Continue" })
```

**4. Scroll to off-screen content.**

```
swipeOn({ direction: "up", lookFor: { text: "Terms of Service" } })
```

VoiceOver scrolling is not currently supported. Avoid using `swipeOn` to reach off-screen content while VoiceOver is active; use an app-specific supported navigation path or disable VoiceOver for that portion of the automation.

**5. Disable VoiceOver when the test session is complete.**

Use **Simulator > Features > Toggle VoiceOver** again, or **Option + Command + F5**.

---

## Known Edge Cases

**Element grouping changes selectors.** When a parent container groups child labels into a single accessibility element, targeting the individual child text values will not match. Check the grouped `content-desc` on the parent instead. `observe` output shows the combined value, so inspect it before writing selectors.

**Decorative elements are invisible.** Icons, dividers, and other purely visual elements marked as not important for accessibility do not appear in the tree. Do not rely on them as anchors for selectors.

**Virtual nodes reject coordinate taps.** Controls like sliders or page indicators may be represented as virtual nodes. If you observe unexpected failures on such controls, inspect the `observe` output to confirm the node exists and use its supported semantic interaction.

**VoiceOver scrolling is unsupported.** CtrlProxy's `scroll_forward` and `scroll_backward` endpoints use XCTest-synthesized swipes, and those touches are delivered below VoiceOver's gesture layer. Supplying a `container` selector does not provide a VoiceOver-aware fallback, so `swipeOn` returns an actionable unsupported result while VoiceOver is active.

**Private XCTest multi-touch limitation.** `executeGesture` multi-touch uses private XCTest event-synthesis APIs because public `XCUICoordinate` gestures only drive one pointer. Those synthesized touches do not reach VoiceOver, so they cannot invoke VoiceOver's gesture vocabulary. AutoMobile returns a descriptive CtrlProxy error if the private symbols are unavailable on the active Xcode/iOS version.

**VoiceOver cursor requires the iOS SDK.** For SDK-enabled apps, `observe().accessibilityFocusedElement` identifies the VoiceOver cursor. For apps without the SDK, validate interactions by checking the expected navigation or state change.

**CtrlProxy required.** VoiceOver detection and accessibility actions require the CtrlProxy runner to be connected. If the CtrlProxy is unavailable, AutoMobile falls back to standard (non-VoiceOver) behavior with a warning logged.
