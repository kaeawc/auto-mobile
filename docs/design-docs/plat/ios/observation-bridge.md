# iOS SDK observation bridge

`AutoMobileObservationBridge` lets a host app serve observations and actions from inside the app,
with stale-observation and actionability checks the SDK enforces. AutoMobile uses it as an
alternate backend behind the existing `observe` and action tools, not as separate tools (#5159,
following #7627's one capture, one selector schema, one resolver).

## Discovery

A host opts in by registering its bridge:

```swift
AutoMobileObservationRegistry.shared.register(bridge, supportedActions: [.tap, .insertText, .scroll])
```

`supportedActions` defaults to every `AutoMobileActionKind`. The SDK never builds a bridge itself.

The registry's `ObservationBridgeState` (`ios/sdk-wire`) is served in the SDK's `/health` payload
as `observationBridge`. CtrlProxy copies it into the `get_sdk_capabilities` reply. The daemon
caches it with the rest of that reply, under the same generation binding, so a probe answered for
one foreground app never answers for another.

```json
{ "schemaVersion": 1, "available": false, "reason": "NOT_REGISTERED", "supportedActions": [] }
```

`IOSCtrlProxyClient.getObservationBridgeStateForIos(appId)` returns either `available` with the
schema version and sorted action kinds, or `unavailable` with one of these reasons:

| Reason               | Meaning                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `NOT_REGISTERED`     | the SDK is present, but no bridge is registered                                              |
| `SDK_TOO_OLD`        | the SDK or the runner predates discovery                                                     |
| `SDK_UNAVAILABLE`    | the foreground app does not embed the SDK, it is another app, or the runner is not connected |
| `MALFORMED_RESPONSE` | the bridge object does not match the schema                                                  |
| `UNKNOWN`            | a reason written by a newer SDK                                                              |

A failed probe throws `SdkCapabilityQueryError` instead of returning `unavailable`, so a timeout is
never mistaken for a missing bridge. CtrlProxy also drops a malformed bridge object rather than
failing the whole capability reply.

## Observation and action commands

The SDK serves two routes, which CtrlProxy relays as commands:

| SDK route                    | CtrlProxy command                                    | Reply                                                |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `POST /observation/snapshot` | `request_sdk_observation` → `sdk_observation_result` | the bridge's `AutoMobileObservationSnapshot`         |
| `POST /observation/action`   | `request_sdk_action` → `sdk_action_result`           | the bridge's `AutoMobileActionResult` for one action |

The snapshot, action and result types live in `ios/sdk-wire`, so the SDK and CtrlProxy share one
encoding. An action is Swift's synthesized enum shape, `{"tap":{"observationIdentity":41,"elementId":"submit"}}`;
the daemon sends it as the string field `actionJson`. `captureIdentity` is a `UInt64`, and values
above 2^53 lose precision in the daemon.

CtrlProxy calls the SDK only when the foreground app's `/health` reports an available bridge.
Otherwise the command fails with a typed `failure`:

| `failure`            | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `bridge_unavailable` | no SDK in the foreground app or no registered bridge; nothing was sent |
| `app_not_active`     | the app resigned active before the SDK served the request              |
| `invalid_action`     | `actionJson` is missing or is not an `AutoMobileAction`                |
| `bad_reply`          | a sent request got no answer, or the reply does not match the contract |

`available` is false only for `bridge_unavailable`. A bridge rejection is a result, not a failure:
the SDK checks the declared `supportedActions` first (`unsupported_action`), then the bridge checks
`stale_observation`, `unknown_element`, `element_not_actionable` and `action_in_flight`, and the
host executor can return `action_queue_overloaded` or `action_cancelled`. The result carries
`success: false` and the reason. An accepted action carries `nextObservationIdentity`, the capture
the bridge took after it.

Bridge requests share the runner's SDK data budget (2 s per request, 5 s in total). A daemon-side
timeout on `request_sdk_action` reports `available: true`, because the action may have run. Neither
reply is stall evidence for runner recovery: a slow host executor is not a stalled runner.

## Backend selection

The `ios-sdk-observation-bridge` feature flag (default on) gates routing. With it off, or for an app
with no registered bridge, iOS observe and actions are XCTest-only and carry neither field below.

**Observe.** After the XCTest hierarchy is projected, the iOS collector asks the bridge for a
snapshot (2 s budget) and merges it in place under the `XCUIApplication` node, so system UI, alerts
and the keyboard stay observable. Each visible bridge node maps onto the existing attributes (`id`
→ `resource-id` and `test-tag`, `label` → `content-desc`, `value` → `text`, `role` → `class`;
`enabled` nodes are `clickable`) and carries `sdk-element-id` and `sdk-capture-identity`, so the
shared selector schema and resolver match it unchanged. XCTest leaves with the same bounds and the
same label or id as a bridge node are removed as duplicates. Bridge nodes carry `sdk.source:
sdkBridge` in `extras`. The result reports `backend: sdk`, or `backend: xctest` with
`fallbackReason: unavailable` when a registered bridge did not answer. A failed discovery probe
reports neither.

The tap-time fresh read merges the bridge the same way, so a revalidated target keeps its bridge
identity. Cached hierarchy reads outside observe are XCTest-only: a target resolved from one has no
bridge identity and taps through XCTest.

**tapOn.** A target that carries a bridge identity is tapped through the bridge, naming the
observation it came from: `tap` maps to the bridge's tap and `longPress` to its long press with the
press duration. The result reports `backend: sdk`, and an accepted tap is never repeated through
XCTest by the retry-if-no-change path. XCTest stands in only when the bridge is unavailable
(`fallbackReason: unavailable`) or answers `unsupported_action`, or the action has no bridge form
such as a double tap (`fallbackReason: unsupported`). Every other result fails closed with the
bridge's reason: `stale_observation`, `unknown_element`, `element_not_actionable`,
`action_in_flight`, `action_queue_overloaded`, `action_cancelled`, `app_not_active`, `bad_reply`,
and a timeout after the action may have run. Tapping whatever XCTest now finds at those
coordinates could act on a different element. A focus tap issued by `sendKeys` is not routed yet.

WKWebView DOM nodes (#5162) extend the same observation under their WKWebView node.
