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

## WKWebView snapshot and action commands

A host opts each `AutoMobileWebViewBridge` in explicitly, and the SDK never registers one itself
(#5162):

```swift
AutoMobileWebViewRegistry.shared.register(webViewBridge)
```

The registry's `WebViewBridgeState` is served in `/health` as `webViewBridge`: one entry per
registered web view, in registration order, with its `webViewId`, last committed `url`, sorted
`allowedOrigins` and `contentProcessAvailable`. The SDK serves two routes, which CtrlProxy relays:

| SDK route                | CtrlProxy command                                      | Reply                                                     |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------- |
| `POST /webview/snapshot` | `request_sdk_web_snapshot` → `sdk_web_snapshot_result` | the web view's latest `AutoMobileWebSnapshot` and its id  |
| `POST /webview/action`   | `request_sdk_web_action` → `sdk_web_action_result`     | the web view's `AutoMobileWebActionResult` for one action |

A snapshot request names a `webViewId`, or none for the first registered web view; the reply also
carries the registered web views from `/health`. The snapshot is the one the bridge's policy
accepted when the page posted it, so it is already bounded to `maxElements` and its values are
redacted when `redactText` is on; nothing unredacted leaves the bridge.

The page script posts a snapshot on load, on every DOM mutation, and (coalesced to one per 100 ms)
after a scroll, a focus change, or an `input` or `change` event, so geometry, focus and typed values
follow the page without a mutation (assigning an input's value changes no DOM attribute). Only the
main frame posts snapshots, and the bridge accepts only main-frame ones: element ids are per
document and actions resolve them in the main frame, so a frame's element could otherwise answer
for another. An element keeps its id for the life of the document; a new element gets the next id
from a counter, so inserting one never reuses an existing id. `visible` requires a non-empty box
and a rendered element (`checkVisibility`, or computed `visibility` where that is unavailable), so
a control hidden by CSS is not visible. An action whose element is no longer in the document throws
in the page, so it is reported as `javascript_error` rather than accepted with nothing done.

An action request names a `webViewId` and sends `actionJson`, one `AutoMobileWebControlAction` in
Swift's enum shape, such as `{"setValue":{"snapshotId":"s1","elementId":"q","text":"hi"}}`. The
wire type holds only the bounded actions (`click`, `focus`, `insertText`, `select`, `scroll`,
`setValue`, `clear`, `scrollIntoView`, `submit`) and has no JavaScript case, so arbitrary script
cannot be expressed: the runner rejects it as `invalid_action` and the SDK as `400 bad_request`.

CtrlProxy calls the SDK only when `/health` lists a web view (for an action, the named one).
Failures add these to the observation commands' codes:

| `failure`                 | Meaning                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `disallowed_origin`       | the page's origin is not allowed by the bridge's policy (each snapshot's frame was checked when posted)                                        |
| `web_process_unavailable` | the web content process terminated and the page has not loaded again; its snapshots are discarded                                              |
| `message_too_large`       | the request or snapshot exceeds the bridge's `maxMessageBytes`                                                                                 |
| `no_snapshot`             | the current document has not posted a snapshot yet; every committed navigation, including a reload, discards the previous document's snapshots |

`invalid_action` also covers a missing `webViewId`. An action's own rejection is a result with
`success: false`: `stale_snapshot` (the snapshot is not one of the current document's four most
recent), `element_not_actionable` (missing, disabled or hidden in that snapshot), `disallowed_origin`,
`web_process_unavailable` (also when the web view has been deallocated or detached), or
`javascript_error` when the bounded script raised. The snapshot command feeds `observe` and the
action command serves `tapOn` (below); the other action tools do not use it yet.

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

**Observe: web views.** When the projected hierarchy contains a `WKWebView` node, the collector
also reads the app's opted-in web views with one unnamed snapshot read (2 s budget), which answers
with the registered list and the first web view's snapshot. A
screen without a `WKWebView` makes no read. A snapshot is merged only when the app registered
exactly one web view and the screen shows exactly one outermost `WKWebView`: nothing ties a
registration to its native view, and the registry orders web views by registration rather than by
screen position, so with two or more the pairing is ambiguous and they stay XCTest-only. Each
visible DOM element of the merged snapshot is attached as a
child of its `WKWebView` node, offset by the web view's origin, clipped to it and truncated to whole
points as the runner truncates XCTest frames; one wholly outside the web view is dropped, as are elements whose id occurs more than once in the snapshot, since an action naming that id could reach either. Elements map onto the existing attributes
(`label` → `content-desc`, `value` → `text`, `role` → `class`; a redacted value is not reported as text but as `value-redacted: "true"`, which text verification treats as unverifiable (unless the replaced XCTest leaf reports a readable `value`); `enabled` elements are `clickable`;
text entry roles such as `input` and `textarea` report `role: textfield`, so focus and `sendKeys`
targeting treat them as editable) and carry `web-view-id`, `web-snapshot-id`, `web-element-id` and, when the page URL has one,
`web-origin`, with `sdk.source: sdkWebBridge` in `extras`. XCTest leaves inside the web view with the same bounds and the same label, value or id as a DOM element are replaced by it in the leaf's place (so container-scoped selectors still find it), and every attribute the fresh leaf reports wins over the snapshot's (its `resource-id`, native `class`, input properties, focus and the rest), so native selectors, field detection and verification keep working; the DOM element adds its web identity and what the leaf does not report, but never its focus, since the snapshot can be older than the XCTest read. A leaf that two DOM elements both match (a wrapper and the control it wraps) is not replaced. A web view
without a snapshot (none posted yet, a disallowed origin, a terminated process) keeps only its
XCTest nodes. A merge reports `backend: sdk` unless the native bridge already set `backend`. The
snapshot id is the DOM elements' capture identity: the web view rejects an action naming one that
is no longer among its four most recent as `stale_snapshot`, as the native bridge rejects a stale
observation.

The tap-time fresh read merges the bridge and the web views the same way, so a revalidated target
keeps its bridge or web identity. Cached hierarchy reads outside observe are XCTest-only: a target resolved from one has no
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
coordinates could act on a different element.

**tapOn on a DOM element.** A target that carries a web identity is clicked through its web view:
`tap` maps to `click`, naming the snapshot the element came from (5 s budget). A long press or a
double tap has no web form: XCTest runs it and reports `fallbackReason: unsupported`. XCTest also
stands in when the web view bridge is unavailable (`fallbackReason: unavailable`). Every web
rejection fails closed with its reason (`stale_snapshot`, `element_not_actionable`,
`disallowed_origin`, `web_process_unavailable`, `javascript_error`), as does any other failure,
including a timeout after the click may have run. A `sendKeys` focus tap on a DOM element stays on
XCTest.

**sendKeys.** When the field `sendKeys` focused is a bridge node, its text entry goes through the
bridge's `insertText` and its clear (the `clear` command and the clear before a replace) through
`clearText`, under the same fallback and fail-closed rules as `tapOn`. Each command result reports
`backend` and, for an XCTest stand-in, `fallbackReason`; a command that used both reports the
fallback. The focus tap itself stays on XCTest, so an XCTest stand-in finds the field focused as
usual, and the typed text is verified by read-back as for XCTest typing. IME actions have no
bridge form: on a bridge field they run through XCTest and report `fallbackReason: unsupported`.
`sendKeys` without a selector has no resolved field, so it stays on XCTest.

Any capture moves the bridge's current observation, and the bridge rejects an action naming an older
one. So sendKeys keeps the field's element id, takes the capture identity of every observation it
reads and of every accepted action, and reads the screen once before its first bridge action if
nothing has been read since focus.

**swipeOn.** A container (named or auto-targeted) that is a bridge node scrolls through the
bridge's `scroll` with `delta` set to the change in content offset, in points: start minus end of
the stroke XCTest would have run, so swiping up gives a positive `y`. A screen swipe on a screen
that carries bridge nodes goes through the bridge's `swipe` with the same start, end and duration,
naming the capture the swipe was resolved against. Edge swipes reach system UI the bridge cannot
see and stay on XCTest without a `backend`. A boomerang has no bridge form, so XCTest runs it and
reports `fallbackReason: unsupported`. Other fallbacks and fail-closed results follow `tapOn`. A bridge scroll has no timed stroke, so its result marks the duration as ignored (`durationIgnored`, with a warning when `durationMs` was passed). The display fence is checked right before the bridge dispatch, as it is before an XCTest swipe. The
bridge budget is the gesture's duration plus 3 s, and never less than 5 s. Scroll searches
(`lookFor`) stay on XCTest.

WKWebView DOM nodes (#5162) extend the same observation under their WKWebView node.
