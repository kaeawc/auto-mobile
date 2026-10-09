# iOS simulator overlay agent

Agent-authored overlays (milestone 37, #9295) on iOS simulators, with no SDK in the
target app. This is the iOS counterpart of the
[Android overlay specification](../android/overlay-ux.md); the spec, validation limits
and node vocabulary are shared. See epic #10563 and the prototype in #10498.

Status: epic #10563 is complete apart from device verification. The agent (`ios/overlay-agent/`), the
release dylib and its checksum-verified download (#10564, #10565), the per-launch port, token and
handshake (#10566), `launchApp { overlay: true }` (#10567), `prototype` routing (#10568) and the
advisory per-runtime simulator smoke test (#10569) are merged, and the tool now covers anchors
(#10874), `pressScale` (#10885), `reset` on show (#10998), hiding the overlay from `layer: "app"`
screenshots (#10943, #10988) and the renderer and accessibility fixes that followed (#10903,
#10918, #10928, #10953). Still open: device verification of the iOS window-layer `tapOn` fix from
#10498, and the decisions listed under [Open decisions](#open-decisions).
`scripts/ios/overlay-agent-demo.ts` is a standalone driver that launches with a fresh port and token.

## Feature support

| Feature                                                                  | iOS simulator                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `show`, `dismiss`, `status`, `awaitEvent`; fullscreen, floating, sheet   | Supported                                                                                               |
| Replace in place, and `reset: true` to start fresh                       | Supported (`overlay_show_in_place_v1`)                                                                  |
| Element and bounds anchors                                               | Supported, in points (`overlay_anchor_v1`); see [Anchors](#anchors)                                     |
| `pressScale`, motion, `visibleWhen`, state and actions, assets and fonts | Supported                                                                                               |
| Material component nodes, dialog, snackbar, pickers                      | Supported; see [Material components](#material-components)                                              |
| Overlay hidden from `layer: "app"` observe screenshots (`target`)        | Supported (#10943, #10988); the host restores it after capture                                          |
| `display` selector                                                       | Refused: a simulator has one screen                                                                     |
| `window.layer: "app"`                                                    | Accepted and ignored, silently: the window level is fixed at alert + 1 (decision 3)                     |
| `window.persistence: "device"`                                           | Refused: the agent lives in the app process and dies with it                                            |
| `inspect`                                                                | Supported (`overlay_inspect_v1`); see [Inspect](#inspect)                                               |
| Idle TTL and dismissal on host disconnect                                | Supported; see [Expiry](#expiry). Reasons `user`, `agent`, `ttl`, `disconnect`                          |
| Bottom sheet lifting above the keyboard                                  | Supported, not yet device-verified; see [Bottom sheet and the keyboard](#bottom-sheet-and-the-keyboard) |
| Foreground scoping to the shown-over app                                 | Not needed: the agent lives in the app, so backgrounding the app hides its window                       |

## Open decisions

These are undecided; the table above describes today's code, and nothing here promises a behaviour.

1. Decided 2026-10-09: `inspect` maps to the agent's `get_overlay_status` (see [Inspect](#inspect)).
2. Decided 2026-10-09: a bottom sheet lifts above the keyboard from keyboard-frame notifications
   (see [Bottom sheet and the keyboard](#bottom-sheet-and-the-keyboard)). Still open: a simulator
   check.
3. Decided 2026-10-09: `window.layer: "app"` is accepted and ignored silently on iOS, with no
   warning, so one spec runs on both platforms. The overlay stays at window level alert + 1.
   spec runs on both platforms.

## Expiry

Owner decision 2026-10-09: iOS overlays expire exactly like Android session overlays
([Lifecycle and safety](../android/overlay-ux.md#lifecycle-and-safety)).

- **Idle TTL.** Five minutes (300,000 ms; `OverlayIdleTimer`, settable locally through
  `OverlayModel.idleTtlMilliseconds`, no wire field). An accepted `show_overlay` (including a same-id
  replace) and a user interaction (taps, edits, a pager page that actually changed) restart it.
  Initial pager reports, a snackbar's own `durationMs` close, `hide_for_capture` and `get_overlay_status`
  do not. A hidden overlay still expires.
- **Disconnect.** The overlay belongs to the host session, not one socket. The agent counts
  authenticated connections (`OverlayClientTracker`); when the last one closes the overlay is dismissed
  and the uploaded assets are dropped, whether or not an overlay was showing. A `show_overlay` handled
  after that edge is dismissed the same way.
- **Events.** Each expiry emits one `overlay_event` `kind: "dismissed"` with a null `name` and
  `payload: {"reason": "ttl"}` or `{"reason": "disconnect"}`, sequenced from the same per-id ledger as every
  other event (the disconnect event has no socket to reach). `user` and `agent` are unchanged.
- **Not applicable.** `teardown` is never emitted: the agent has no service to unbind, and the overlay
  dies with the app process. There is no `persistence: "device"`, so nothing is exempt from the TTL.
- **Host.** No host change or capability is needed: the host holds one persistent connection per
  launch and already treats any `dismissed` event as removing shown status.

## How it works

1. `ios/overlay-agent/` builds a small simulator-only dylib, ad-hoc signed. It needs no
   Developer ID identity, notarization or provisioning because it only loads into simulator
   processes.
2. The app is launched with `simctl launch` and the child environment variable
   `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` pointing at the dylib. `simctl` strips the
   `SIMCTL_CHILD_` prefix, so dyld loads the library into the app before `main()`.
3. The agent adds a SwiftUI `UIWindow` at window level `.alert + 1`, above the app's own
   windows, and renders the shared overlay spec into it.
4. The window's `hitTest` returns `nil` outside the overlay content, so touches there pass
   through to the app. Floating cards therefore leave the live app usable.
5. The agent listens on a loopback (`127.0.0.1`) TCP socket and speaks the CtrlProxy overlay
   message names (`show_overlay`, `dismiss_overlay`, `put_overlay_asset`, `overlay_result`,
   `overlay_event`) as newline-delimited JSON. There is no `update_overlay` (#10490): a
   `show_overlay` with the id already shown replaces it in place.
6. Each launch gets its own port and a random token. The host passes them as
   `AUTOMOBILE_OVERLAY_PORT` and `AUTOMOBILE_OVERLAY_TOKEN`; the first frame on a connection
   must be a `hello` carrying the token, and the agent replies with its version and
   capabilities. The agent does not start its server without both values, and the token
   must be at least 16 characters.

Because the window lives inside the app's process, `observe`, `tapOn`, `sendKeys`,
screenshots and video recording all see the overlay the same way they see app UI.

## Limits

- **Simulator only.** On physical devices code signing blocks the injection. Use the in-app
  SDK route for devices.
- **Only apps launched with the agent.** Injection happens at launch, so enabling it for a
  running app means relaunching it, which loses in-memory app state. An app started any
  other way (home screen, a plain `launchApp`, Xcode) has no agent unless you set it up as
  described below.
- **SpringBoard and system UI are not covered**, so the home screen cannot host an overlay.
- Overlays disappear when the app exits or is relaunched without the agent.

## Entry point: `launchApp { overlay: true }`

`launchApp` with `overlay: true` on an iOS simulator is the intended entry point (#10567).
It resolves the dylib, allocates a port and token, launches with the `SIMCTL_CHILD_*`
environment, and records the agent against the device and bundle id so `prototype` can
connect. A normal `launchApp` injects nothing. Any `DYLD_INSERT_LIBRARIES` you already set
is preserved. On a physical device the option fails with a simulator-only error.

If `prototype` targets an app that was not launched this way, it fails and tells you to
relaunch with `launchApp { overlay: true }` rather than relaunching on its own, because a
relaunch loses state.

## Where the dylib comes from

The client resolves the dylib in this order (#10565):

1. An explicit path.
2. The `AUTOMOBILE_IOS_OVERLAY_AGENT` environment variable, a path to a local build. Use it
   for repository checkouts and development builds.
3. The local build output.
4. A download of the release asset, checksum-verified and cached under
   `~/.auto-mobile/overlay-agent/`.

If there is no pinned checksum for the running build, the client reports that the overlay
agent is unavailable instead of using unverified bytes. Set
`AUTOMOBILE_SKIP_IOS_OVERLAY_AGENT_DOWNLOAD` to disable the download.

## Apps launched from Xcode

When you run the app from Xcode, AutoMobile does not launch it, so add the injection to the
scheme yourself:

1. Product, Scheme, Edit Scheme, select **Run**, then the **Arguments** tab.
2. Under **Environment Variables**, add `DYLD_INSERT_LIBRARIES` with the absolute path of the
   dylib: the cached file under `~/.auto-mobile/overlay-agent/`, or the file named by
   `AUTOMOBILE_IOS_OVERLAY_AGENT` for a local build.
3. Add `AUTOMOBILE_OVERLAY_PORT` and `AUTOMOBILE_OVERLAY_TOKEN` (at least 16 characters) with
   values you also give the client, since AutoMobile did not choose them.
4. Run on a **simulator** destination. In a scheme the variable is `DYLD_INSERT_LIBRARIES`
   itself; the `SIMCTL_CHILD_` prefix applies only to `simctl launch`.

Do not enable this on device destinations or in archive/release configurations; the dylib
is simulator-only and device launches will fail to load it.

## Differences from Android

- `prototype` on iOS has no `showVariants` and no `update` action (removed by owner decision).
  Showing a spec with an id that is already shown updates it in place, keeping each pager's page;
  `reset: true` starts it fresh (the agent advertises `overlay_show_in_place_v1`, and the host refuses
  `reset` on an older agent). For a variant
  carousel, compose the spec yourself and `show` it.
- No `display` selector and no `window.persistence: "device"`; the host refuses them.
  `window.layer: "app"` is accepted and ignored. See [Feature support](#feature-support).
- `inspect` reports the one overlay the agent shows, with no `suspended` and no
  `deviceDroppedEvents` (nothing is persisted or buffered offline). Idle TTL and disconnect
  dismissal match Android; see [Expiry](#expiry).
- Rendering is SwiftUI in the app's process rather than Compose in CtrlProxy, so there is no
  separate accessibility service involved.
- Android reaches any app through CtrlProxy; iOS reaches only apps launched with the agent.

## Inspect

`inspect` (#10494 on Android) asks the device which overlays it shows and adopts them into the host's
`status` and `awaitEvent` state, for use after a session release or daemon restart. On iOS the host
sends `get_overlay_status` and adopts its reply. The agent holds at most one overlay and dies with the
app, so the report is that one overlay: `id`, `state`, `pages` and `lastSequence` (the agent's event
ledger for the id, so the host resumes past it), with `persistent: false`. The agent also replies
`visible`, whether its window is on screen, which the host does not surface. There is no `suspended`
(the overlay lives in the app, so backgrounding the app hides its window), no offline event replay
and no `deviceDroppedEvents`. An overlay the host lists that the agent no longer shows is dropped.

The agent advertises `overlay_inspect_v1` for the `lastSequence` and `visible` fields. The host
refuses `inspect` on an agent without it, before sending anything, and asks to relaunch with
`launchApp { overlay: true }` to load the current agent.

## Bottom sheet and the keyboard

Owner decision 2026-10-09, matching [Android](../android/overlay-ux.md#bottom-sheet-and-the-keyboard-10262):
a `sheet` with `edge: "bottom"` (or no edge) moves above the software keyboard while it is shown and
returns to the screen edge when it hides. Fullscreen, floating and top sheets never move.

- **Source.** The agent runs in the app's process, so `keyboardWillChangeFrame` and
  `keyboardWillHide` are the notifications of the keyboard the app shows. The lift is how far the
  keyboard's end frame reaches into the overlay window (`OverlayKeyboardLift.amount`, in the
  UIKit-free core), 0 for a hardware keyboard or a hidden one, and never more than the window.
- **No double lift.** SwiftUI's own keyboard avoidance is turned off for a bottom sheet, so only
  this lift moves it; floating overlays keep SwiftUI's push.
- **Touch and clip.** The sheet's content is padded up by the lift inside its full-window frame, so
  its reported touch rect moves with it, and the anchor layer's clip region is computed with the same
  lift (`OverlaySheetFrame.rect(lift:)`), so anchored nodes and their touch targets stay in sync.
- **Motion.** The move animates over the keyboard's own duration, with an ease-in-out curve (UIKit's
  private keyboard curve is not public API). It is instant under spec `motion: "none"` or Reduce
  Motion (`OverlayKeyboardLift.animationDuration`).
- **Not yet verified on a simulator.** No simulator was driven for this change.

## Anchors

Node anchors (#9316) work as on [Android](../android/overlay-ux.md#anchors), in points.
The host resolves each element anchor once at show against a fresh hierarchy of the app
alone (the agent's own window, found by its dismiss control, is excluded) and sends it as
a bounds anchor. iOS hierarchy bounds are already points, the unit iOS spec sizes use, so
no density conversion happens; the result's `anchors[].boundsPx` and `bounds` carry the
same point values. The host sends anchors only to an agent whose handshake advertises
`overlay_anchor_v1`, and refuses the show otherwise (relaunch with `launchApp
{ overlay: true }` to load the current agent). The agent refuses an element anchor that
reaches it unresolved.

The agent draws anchored nodes in a window-level layer above the spec tree (above its
modal, for a node inside a dialog), so a parent neither reserves a slot for one nor clips
it, and its touch target and accessibility frame are where it is drawn. The layer places
a node at its anchor's screen rectangle less the layer's own screen origin: the overlay
window's screen origin plus the layer's position in the window. For a fullscreen overlay
the layer sits in the content area below the dismiss bar, so anchors are shifted up by the
bar and an anchor under the bar is clipped. `cover` sizes the node to the bounds, ignoring
authored width and height; the edges keep the node's size, align that edge and centre it
on the other axis; `start` and `end` follow the layout direction; `offset` applies last,
in screen axes. Only the root of a floating overlay may be anchored, as on Android; with
no window to move, the layer places the anchored root itself and the rest of the screen
stays touchable. Anchors are resolved once and do not follow later scrolling.

## Material components

The agent draws every component node of the shared vocabulary (#10439) with SwiftUI and
follows Android's behavior for each: what a tap, pick or drag does, the `change` events it
emits, and the `<testTag>.<part>` identifiers of composite parts. The tap semantics live in the
UIKit-free core (`OverlayComponents.swift`), so the `simulate_tap` test hook performs the same
transition as a real tap, including on a part identifier.

| Node                            | iOS drawing                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `switch`, `checkbox`            | One toggle element with a SwiftUI-drawn track (no `UISwitch`); a checkbox is a button that reads as selected     |
| `button`                        | `.borderedProminent` filled, `.bordered` tonal/outlined/elevated, `.borderless` text; optional leading SF Symbol |
| `slider`                        | `Slider` with `step` snapping, one adjustable element labelled by `label`                                        |
| `chip`                          | Rounded button; a filter chip toggles its key and reads as selected                                              |
| `card`                          | Rounded container, filled, elevated (shadow) or outlined                                                         |
| `radioGroup`, `segmentedButton` | One button per option, identified `<testTag>.<value>`, with a selected trait                                     |
| `listItem`                      | One row element; a toggle when it has a trailing switch or checkbox                                              |
| `iconButton`, `fab`             | Icon buttons labelled by `contentDescription`, a FAB's `label`, else the icon                                    |
| `topAppBar`                     | Header title; `<testTag>.navigation` and `<testTag>.actions.<index>` buttons                                     |
| `divider`, `badge`, `progress`  | Hairline, dot or count capsule, determinate `ProgressView` or ring, indeterminate sweep                          |
| `timePicker`, `datePicker`      | Wheel `DatePicker` (one `change` per edit), graphical `DatePicker` in UTC days                                   |
| `dialog`, `snackbar`            | Drawn above the author tree inside the overlay window; `<testTag>.confirm`, `.dismiss`, `.action`                |

A segmented `Picker` cannot carry per-segment accessibility identifiers, so segmented buttons
are drawn as a row of buttons. A dialog's scrim covers the whole window (below the dismiss
bar in fullscreen) and takes every touch while it is open, even for floating or sheet
placements; a snackbar takes touches only on itself. A dialog's title (a header), text, child
controls and buttons are each their own accessibility element. While a dialog is open the page
behind it (the spec tree and its anchor layer) is collapsed out of the accessibility tree, as it
is inert to touches; `accessibilityHidden` alone did not keep it out of the XCUITest snapshot
(#10899). The dialog itself is not marked modal (#10912). Otherwise each layer is its own
accessibility container, so a page whose only element is one node reports that node at its own
frame, not the whole page's (#10898). Opening or closing a dialog drops keyboard focus in the overlay unless the
dialog holds a text field; a child taller than the screen scrolls. Material icon names map to
SF Symbols; a name without a mapping draws a placeholder.

A snackbar that sets `durationMs` closes itself that long after it opens, by writing `!equals` to
its `openWhen` key like any other close (a plain timer behind an injectable `OverlayClock`).
Motion matches Android (#10442, #10439): a `visibleWhen` node fades and expands in and out, its
`transition` (`none`, `fade`, `expand`, `slide`) picks the animation, and pager page changes
animate. A `box`, `row` or `column` also animates its size (Android's `animateContentSize`) when a
direct child appears, disappears or resolves to a new width or height, so siblings slide into
freed space; unrelated state changes such as typing do not animate. The animation is scoped to
`OverlayNode.containerLayoutSignature`, so only layout changes trigger it. Spec `motion: "none"` or
the system's Reduce Motion (`UIAccessibility.isReduceMotionEnabled`) makes every change instant.

The host's dismiss control (`automobile-overlay-dismiss`, "Dismiss overlay") cannot be removed
by the spec. In fullscreen it sits in a bar across the top of the window, like Android's
dismiss bar: the bar clears the status bar and cutout, is only as tall as the 44 pt control, is
translucent and follows the spec's light or dark theme, and the spec is laid out below it, so
the control never covers spec content. `safeAreaPadding` inside a fullscreen spec therefore
sees no top inset. Floating and sheet overlays keep the control at the window's top trailing
corner.

See the [`prototype` tool reference](../../../tools.md#prototype).
