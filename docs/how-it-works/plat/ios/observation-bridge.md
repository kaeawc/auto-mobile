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

A host opts each `AutoMobileWebViewBridge` in explicitly; the SDK never registers one
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
carries the registered web views from `/health`. The bridge's policy applied when the page posted
the snapshot, so it is already bounded to `maxElements`, with values redacted when `redactText` is
on; nothing unredacted leaves the bridge.

The page script posts a snapshot on load and on every DOM mutation. It also posts after a scroll, a
focus change, an `input` or `change` event, a window resize, or a visual-viewport resize or scroll
(pinch zoom and its pan), coalesced to one per 100 ms. So geometry, the viewport, focus and typed
values follow the page without a mutation (assigning an input's value changes no DOM attribute).

Only the main frame posts snapshots, and the bridge accepts only main-frame ones. Element ids are
per document and actions resolve them in the main frame, so a frame's element could otherwise
answer for another. An element keeps its id for the life of the document. A new element gets the
next id from a counter, so inserting one never reuses an existing id. The `visible` flag requires a
non-empty box and a rendered element (`checkVisibility`, or computed `visibility` where
unavailable), so a control hidden by CSS is not visible. An action on an element no longer in the
document throws in the page and reports `javascript_error` instead of a no-op success.

An action request names a `webViewId` and sends `actionJson`, one `AutoMobileWebControlAction` in
Swift's enum shape, such as `{"setValue":{"snapshotId":"s1","elementId":"q","text":"hi"}}`. The
wire type holds only the bounded actions (`click`, `focus`, `insertText`, `select`, `scroll`,
`setValue`, `clear`, `scrollIntoView`, `submit`) and has no JavaScript case. The runner rejects
arbitrary script as `invalid_action`, and the SDK as `400 bad_request`.

CtrlProxy calls the SDK only when `/health` lists a web view (for an action, the named one).
Failures add these to the observation commands' codes:

| `failure`                 | Meaning                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `disallowed_origin`       | the page's origin is not allowed by the bridge's policy (each snapshot's frame was checked when posted)                                        |
| `web_process_unavailable` | the web content process terminated and the page has not loaded again; its snapshots are discarded                                              |
| `message_too_large`       | the request or snapshot exceeds the bridge's `maxMessageBytes`                                                                                 |
| `no_snapshot`             | the current document has not posted a snapshot yet; every committed navigation, including a reload, discards the previous document's snapshots |

`invalid_action` also covers a missing `webViewId`. An action's own rejection is a result with
`success: false` and one of these reasons:

- `stale_snapshot`: the snapshot is not one of the current document's four most recent;
- `element_not_actionable`: missing, disabled or hidden in that snapshot;
- `disallowed_origin`;
- `web_process_unavailable`, also when the web view has been deallocated or detached;
- `javascript_error`: the bounded script raised.

The snapshot command feeds `observe` and the
action command serves `tapOn` (below); the other action tools do not use it yet.

## Backend selection

The `ios-sdk-observation-bridge` feature flag (default on) gates routing. With it off, or for an app
with no registered bridge, iOS observe and actions are XCTest-only and carry neither field below.

**Observe.** After projecting the XCTest hierarchy, the iOS collector asks the bridge for a
snapshot (2 s budget) and merges it in place under the `XCUIApplication` node, so system UI, alerts and the keyboard stay observable. Each visible bridge node maps onto the existing
attributes (`id` → `resource-id` and `test-tag`, `label` → `content-desc`, `value` → `text`,
`role` → `class`; `enabled` nodes are `clickable`). It carries `sdk-element-id` and
`sdk-capture-identity`, so the shared selector schema and resolver match it unchanged. The
collector drops XCTest leaves that duplicate a bridge node's bounds and label or id. Bridge nodes carry `sdk.source: sdkBridge` in `extras`.

The result reports `backend: sdk`, or `backend: xctest` with `fallbackReason: unavailable` when a
registered bridge did not answer or reported a `coordinateSpace` other than `screen`. Window- or
view-relative bounds would put a bridge node at the wrong screen point for a tap that falls back to
XCTest. So the collector skips such a snapshot, leaving the XCTest hierarchy unchanged. A failed
discovery probe reports neither.

**Observe: web views.** The collector also makes one unnamed snapshot read (2 s budget) only when the
projected hierarchy contains exactly one outermost `WKWebView`, the only screen that can merge. The
read returns the registered web views and the first one's snapshot. The collector logs a reply it
cannot read (`bad_reply`), and the observation stays XCTest-only.

It merges the snapshot only when the app also registered exactly one web view. Nothing ties a
registration to its native view, and the registry orders web views by registration rather than by screen position. Two or more stay
XCTest-only, since the pairing is ambiguous. Each visible DOM element of the merged snapshot
becomes a child of its `WKWebView` node:

- Bounds: CSS-pixel bounds map to points through the snapshot's visual viewport. It
  subtracts the viewport's offset and scales its CSS width to the web view's width minus the
  reported adjusted content insets. This covers pages without a `device-width` viewport and
  pinch zoom. A snapshot without a viewport counts as points. Bounds start at the inset-reduced
  page origin, clip to the full web view frame and truncate to whole points, as the runner
  truncates XCTest frames. Missing, negative or non-finite inset fields count as zero.
- Dropped: an element wholly outside the web view, and elements whose id repeats in the snapshot,
  since an action naming that id could reach either.
- Attributes: `label` → `content-desc`, `value` → `text`, `role` → `class`; `enabled` elements are
  `clickable`. A redacted value reports `value-redacted: "true"` instead of text, which text
  verification treats as unverifiable unless the replaced XCTest leaf reports a readable `value`.
- Text fields: text entry roles such as `textarea`, and an `input` whose reported `inputType` is
  text-like (`text`, `search`, `email`, `url`, `tel`, `password`, `number`, or none), report
  `role: textfield`. Focus and `sendKeys` targeting treat them as editable, but not a checkbox
  input.
- Identity: `web-view-id`, `web-snapshot-id`, `web-element-id`, and `web-document-id` (the page
  document that posted the snapshot; element ids restart for each document) when the SDK reports
  it. Also `web-origin` when the page URL has one, and `sdk.source: sdkWebBridge` in `extras`.

A DOM element takes the place of each XCTest leaf inside the web view with the same bounds and
label, value or id, so container-scoped selectors still find it. Every
attribute the fresh leaf reports wins over the snapshot's (its `resource-id`, native `class`, input
properties, focus and the rest), so native selectors, field detection and verification keep
working. The DOM element adds its web identity and what the leaf does not report, but never its
focus, since the snapshot can be older than the XCTest read. A leaf stays when two DOM elements
match it (a wrapper and the control it wraps), or when its attributes match different DOM
elements.

A web view without a snapshot (none posted yet, a disallowed origin, a terminated process) keeps
only its XCTest nodes. A merge reports `backend: sdk` unless the native bridge already set
`backend`. The snapshot id is the DOM elements' capture identity. The web view rejects an action
naming one outside its four most recent as `stale_snapshot`, as the native bridge
rejects a stale observation.

The tap-time fresh read merges the bridge and the web views the same way, so a revalidated target
keeps its bridge or web identity. Cached hierarchy reads outside observe are XCTest-only: a target resolved from one has no
bridge identity and taps through XCTest.

**`tapOn`.** A target with a bridge identity is tapped through the bridge, naming the
observation it came from: `tap` maps to the bridge's tap and `longPress` to its long press with the
press duration. The result reports `backend: sdk`, and the retry-if-no-change path never repeats an
accepted tap through XCTest. XCTest stands in only when the bridge is unavailable
(`fallbackReason: unavailable`) or answers `unsupported_action`, or the action has no bridge form
such as a double tap (`fallbackReason: unsupported`). Every other result fails closed with the
bridge's reason: `stale_observation`, `unknown_element`, `element_not_actionable`,
`action_in_flight`, `action_queue_overloaded`, `action_cancelled`, `app_not_active`, `bad_reply`,
and a timeout after the action may have run. An XCTest tap at those coordinates could hit a
different element.

**`tapOn` on a DOM element.** A target with a web identity is clicked through its web view:
`tap` maps to `click`, naming the snapshot the element came from (5 s budget). A long press or a
double tap has no web form: XCTest runs it and reports `fallbackReason: unsupported`. XCTest also
stands in when the web view bridge is unavailable (`fallbackReason: unavailable`). Every web
rejection fails closed with its reason (`stale_snapshot`, `element_not_actionable`,
`disallowed_origin`, `web_process_unavailable`, `javascript_error`), as does any other failure,
including a timeout after the click may have run. A `sendKeys` focus tap on a DOM element stays on
XCTest.

**`sendKeys`.** When the field `sendKeys` focused is a bridge node, its text entry goes through the
bridge's `insertText`. Its clear (the `clear` command and the clear before a replace) goes through
`clearText`, both under the same fallback and fail-closed rules as `tapOn`. Each command result
reports `backend` and, for an XCTest stand-in, `fallbackReason`; a command that used both reports
the fallback.

The focus tap itself stays on XCTest, so an XCTest stand-in finds the field focused, and read-back
verifies the typed text as for XCTest typing. Focused values filling XCUI's
512-character read window cannot prove a change beyond it; typing succeeds with a short unverified
warning, and timeout read-back leaves what was committed unknown. IME actions have no native bridge
form: on a native bridge field they run through XCTest and report `fallbackReason: unsupported`.
Without a selector, `sendKeys` has no resolved field, so it stays on XCTest.

A focused DOM `<input>` or `<textarea>` merged from a web view (each merged element carries its DOM
role as `web-role`) routes the same way through the web view's bounded actions. Other DOM editors,
such as `contenteditable`, ignore an assigned `value` and stay on XCTest. For a routed field:

- A clear is `clear`, and IME `done` is `submit` (the field's form, if it has one).
- Text entry is `setValue`, which replaces the value, so the command uses it only after clearing
  the field through the web view (a replace). Typing that appends at the caret stays on XCTest and
  reports `fallbackReason: unsupported`, as do the other IME actions.
- Only a field with a `web-document-id` routes this way, since without one a navigation looks like
  the same page.
- The field keeps its web view, element id (stable across the document's snapshots) and document
  id, and takes the snapshot id of every observation that shows it in the same document.
- When that element id appears in a new document (the page navigated), its next action fails
  closed. When the fresh read before its first action no longer shows it (the element left, or no
  snapshot merged), XCTest stands in and the result reports `fallbackReason: unavailable`.
- A rejected web action fails closed.

After Tab or any IME action, which can move focus or leave the page, the command forgets the field
(native or web). Later text actions follow keyboard focus through XCTest.

Any capture moves the bridge's current observation, and the bridge rejects an action naming an older
one. So `sendKeys` keeps the field's element id and takes the capture identity of every observation
it reads and every accepted action. It reads the screen once before its first bridge action if
nothing has been read since focus.

**`swipeOn`.** A container (named or auto-targeted) that is a bridge node scrolls through the
bridge's `scroll`. Its `delta` is the change in content offset, in points: start minus end of the
stroke XCTest would have run, so swiping up gives a positive `y`. A screen swipe on a screen that
carries bridge nodes goes through the bridge's `swipe` with the same start, end and duration,
naming the capture it resolved against. Edge swipes reach system UI the bridge cannot
see and stay on XCTest without a `backend`. A boomerang has no bridge form, so XCTest runs it and
reports `fallbackReason: unsupported`. Other fallbacks and fail-closed results follow `tapOn`.

A bridge scroll has no timed stroke, so its result sets `durationIgnored` (with a warning when
`durationMs` was passed). The display fence check runs right
before the bridge dispatch, as it does before an XCTest swipe. The bridge budget is the gesture's
duration plus 3 s, at least 5 s.

Scroll searches (`lookFor`) swipe with XCTest, after one web-view step. The page scrolls the target
into view with `scrollIntoView` when:

- the target is not in view;
- the search is unscoped (no container, scoped `lookFor` or layer, which the snapshot cannot
  express);
- the screen shows exactly one web view;
- `lookFor.text` names exactly one enabled, visible DOM element of its snapshot by label or value
  (matched exactly, case and quote style aside; a redacted value never matches).

The snapshot lists off-screen elements, which the merged observation drops. The search then waits
250 ms for the page's next snapshot, re-reads the screen and searches again. A hit reports
`backend: sdk` with no swipe. An unavailable bridge leaves the search to swipe and reports
`fallbackReason: unavailable`, and a rejected scroll fails closed. A target that is no single page
element (an `elementId` selector, an ambiguous or partial text) swipes as before with no `backend`.
