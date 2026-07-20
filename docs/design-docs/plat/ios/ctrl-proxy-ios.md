# Accessibility Bridge

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>📱 Simulator Only</kbd>

> **Current state:** `CtrlProxy iOS` is a fully implemented Swift package (`ios/CtrlProxy iOS/`) with WebSocket server, `ElementLocator`, `GesturePerformer`, `CommandHandler`, `HierarchyDebouncer`, and `DisplayLinkFPSMonitor`. Tests cover command handling, hierarchy debouncing, perf timing, and model serialization. Physical device support requires provisioning (issues [#912–914](https://github.com/jasonpearson/auto-mobile/issues/912)). See the [Status Glossary](../../status-glossary.md) for chip definitions.

The iOS automation server is a native iOS app that exposes the accessibility tree and element
queries over a WebSocket connection. It is the iOS counterpart to the Android accessibility
service and focuses on reliable observation delivery.

## Responsibilities

- Serve the accessibility tree via WebSocket.
- Support element lookup by id, text, and type.
- Provide element bounds for touch injection.
- Emit view hierarchy updates when the UI changes.
- Track first responder and focus state.
- Perform coordinate gestures (tap, swipe, drag) via `GesturePerformer`.

## WebSocket protocol

Client to server command:

```json
{
  "id": "cmd_abc123",
  "action": "getViewHierarchy",
  "params": {}
}
```

Server to client response:

```json
{
  "id": "cmd_abc123",
  "status": "success",
  "result": {
    "timestamp": 1704067200.5,
    "screenSize": { "width": 390, "height": 844 },
    "elements": [
      {
        "id": "UIButton_67890",
        "type": "UIButton",
        "label": "Submit",
        "identifier": "submitButton",
        "frame": { "x": 100, "y": 400, "width": 190, "height": 44 },
        "isEnabled": true,
        "isVisible": true,
        "traits": ["button"]
      }
    ]
  }
}
```

## Gestures

`GesturePerformer` injects coordinate gestures through `XCUICoordinate` anchored on
SpringBoard: tap, long-press, swipe, and **drag**
(`press(forDuration:thenDragTo:withVelocity:thenHoldForDuration:)`). The `dragAndDrop` MCP
tool resolves source/target element centers from a freshly-refreshed view hierarchy and
dispatches through `IOSCtrlProxyClient.requestDrag()` to this path, reaching parity with the
Android accessibility-service drag. The refresh uses `requestHierarchySync` to force a fresh
runner round-trip rather than `getAccessibilityHierarchy`, bypassing the client's (<500ms)
hierarchy cache so a drag started just after a navigation/scroll can't resolve against a
stale snapshot.

The XCUICoordinate drag API takes a velocity (points/second) rather than a duration, so
`GesturePerformer.drag` converts the caller's `dragDurationMs` into the velocity that covers
the source→target distance in that time (`velocity = distance / dragDuration`), falling back
to `.default` when the duration or distance is non-positive. This gives iOS the same
drag-speed control as Android.

`shake` is implemented through the same CtrlProxy command path and posts the
`com.apple.UIKit.SimulatorShake` Darwin notification from the XCUITest runner. This is
simulator-only: XCTest does not expose a public shake API for physical iOS devices. The MCP
`duration` value is used as part of the runner timeout budget on iOS, and `intensity` is
ignored because the simulator shake path does not accept intensity.

Multi-finger swipes use XCTest's private event-synthesis classes
(`XCPointerEventPath` and `XCSynthesizedEventRecord`) so `executeGesture`
`FingerPath[]` input can produce simultaneous touches. Synthesized touches are
delivered below VoiceOver's gesture layer, so VoiceOver does not observe them:
the runner cannot drive VoiceOver's own gesture vocabulary, including Rotor,
Magic Tap, screen curtain, or cursor flicks. The wrapper checks for the private
classes/selectors at runtime and converts synthesis failures or Objective-C
exceptions into normal CtrlProxy error responses. These APIs are undocumented
by Apple, so Xcode or iOS updates can still change their behavior.

> Caveat: on the Simulator the post-drop `thenHoldForDuration:` hold may be a no-op; press
> and drag are reliable. Verify hold-dependent flows on a physical device.

## Limitations

- Simulator-only currently.
- Physical device support requires provisioning (see GitHub issues #912-914).

## See also

- [CtrlProxy iOS](xctestrunner/index.md) - Touch injection via native XCUITest APIs.
- [MCP tool reference](../../mcp/tools.md)
