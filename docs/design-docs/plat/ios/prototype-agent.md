# iOS simulator prototype agent

Agent-authored prototypes (milestone 37, #9295) on iOS simulators, with no SDK in the
target app. This is the iOS counterpart of the
[Android prototype specification](../android/prototype-ux.md); the spec, validation limits
and node vocabulary are shared. See epic #10563 and the prototype in #10498.

Status: epic #10563 is complete apart from device verification. The agent (`ios/prototype-agent/`), the
release dylib and its checksum-verified download (#10564, #10565), the per-launch port, token and
handshake (#10566), `launchApp { prototype: true }` (#10567), `prototype` routing (#10568) and the
advisory per-runtime simulator smoke test (#10569) are merged, and the tool now covers anchors
(#10874), `pressScale` (#10885), `reset` on show (#10998), hiding the prototype from `layer: "app"`
screenshots (#10943, #10988) and the renderer and accessibility fixes that followed (#10903,
#10918, #10928, #10953). Still open: device verification of the iOS window-layer `tapOn` fix from
#10498, and the decisions listed under [Open decisions](#open-decisions).
`scripts/ios/prototype-agent-demo.ts` is a standalone driver that launches with a fresh port and token.

## Feature support

| Feature                                                                               | iOS simulator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show`, `dismiss`, `status`, `awaitEvent`; fullscreen, floating, sheet                | Supported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Replace in place, and `reset: true` to start fresh                                    | Supported (`prototype_show_in_place_v1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Element and bounds anchors                                                            | Supported, in points (`prototype_anchor_v1`); see [Anchors](#anchors)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pressScale`, motion, `visibleWhen`, state and actions, assets and fonts              | Supported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Material component nodes, dialog, snackbar, pickers                                   | Supported; see [Material components](#material-components)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Reusable `components` / `use` nodes (#11053)                                          | Supported: the host expands them before sending, so the agent only sees plain nodes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Prototype hidden from `layer: "app"` observe screenshots (`target`)                   | Supported (#10943, #10988); the host restores it after capture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `display` selector                                                                    | Refused: a simulator has one screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `window.layer: "app"`                                                                 | Accepted and ignored, silently: the window level is fixed at alert + 1 (decision 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `window.persistence: "device"`                                                        | Refused: the agent lives in the app process and dies with it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `window.chrome` (#12064)                                                              | Supported, not yet device-verified: fullscreen only, a device advertising `prototype_window_chrome_v1` honours `none` (default) or `bar`; `none` fills the window including under the status bar (use top-edge `safeAreaPadding`) and a two-finger long press (about 1 s) reveals a dismiss pill for 5 s. The iOS agent advertises the capability, leaves sheet/floating chrome unchanged, and provides accessible exits; older agents keep the bar and explicit `none` is refused with a relaunch hint. `lastResult.chrome` reports the effective chrome for successful fullscreen shows and subsequent host-local status.                                          |
| `inspect`                                                                             | Supported (`prototype_inspect_v1`); see [Inspect](#inspect)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Idle TTL and dismissal on host disconnect                                             | Supported; see [Expiry](#expiry). Reasons `user`, `agent`, `ttl`, `disconnect`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Per-mode colours and images, gradients, role scrims (#11220)                          | Supported, not yet device-verified (`prototype_theme_modes_v1`); see [Light and dark values](#light-and-dark-values)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Appearance override, inference, live re-theme, reported mode (#11222)                 | Supported, not yet device-verified (`prototype_appearance_v1`); see [Appearance](#appearance)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Bottom sheet lifting above the keyboard                                               | Supported, not yet device-verified; see [Bottom sheet and the keyboard](#bottom-sheet-and-the-keyboard)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Style `weight`, `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `aspectRatio` (#11543) | Supported, not yet device-verified: sized by `PrototypeSizing` in Android's order (bounds, then `width`/`height`, then aspect ratio); a weight takes exactly its share of a `row`/`column`'s main axis and beats that axis's size and bounds, and is ignored outside a row or column; `min` wins when it exceeds `max`; content on an axis with no authored size (or `wrap`) is centred in the box a min bound grew, as `wrapContentWidth()`/`wrapContentHeight()` do, while an explicit `width`/`height`/`fill` keeps the node's alignment; weighted stacks mirror under RTL via SwiftUI's own Layout mirroring; sizes are fractional points, not rounded to pixels |
| Data model (#11673)                                                                   | Implemented with `prototype_data_model_v1`: authored tree and repeat-cell guards precede resolution; resolved limits precede repeat expansion; status reports read-only `data`; see [Data model](../android/prototype-ux.md#data-model-11673).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Request action (#12529)                                                               | Implemented, not yet device-verified (`prototype_network_v1` and `prototype_network_device_v1`): `via: "host"` through `prototype_request` / `prototype_response` frames, `via: "device"` through a URLSession client; see [Request action capability](#request-action-capability).                                                                                                                                                                                                                                                                                                                                                                                  |
| [Patch (#11675)](../android/prototype-ux.md#patch-11675)                              | Not implemented: the agent does not advertise `prototype_patch_v1` (the pure applier and shared fixtures exist in the agent core).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Non-scalar state values (`null`, array, object)                                       | Refused at `show`, as Android and the host schema do: state is string, number or boolean only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Foreground scoping to the shown-over app                                              | Not needed: the agent lives in the app, so backgrounding the app hides its window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Accessibility identifier fallback (`node.id`)                                         | Matches Android: only `testTag`, including `<testTag>.<part>` for composite parts. Advertises `prototype_identifier_test_tag_only_v1`; host lifts the platform note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Bottom sheet swipe-dismiss and detent dragging                                        | Matches Android: opens at the first detent, drags between detents, and swipes to dismiss (`dismissOnSwipe` defaults to true). Advertises `prototype_bottom_sheet_drag_v1`; host lifts the platform note.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Built-in icon coverage                                                                | Mapped and explicitly unmapped contract names are listed in `schemas/prototype-ios-icon-symbols.json`; unmapped names draw `questionmark.square` (reviewable list: `ios/prototype-agent/ICON-SYMBOLS.md`). Advertises `prototype_icon_sf_symbols_v1`; host reports affected paths and names under `platformNotes`.                                                                                                                                                                                                                                                                                                                                                   |
| Icon node `variant`                                                                   | Filled/outlined use their SF Symbol form where the table has it; absent forms and rounded/sharp/twoTone draw the default symbol. With no variant, the default SF Symbol is often outlined; use `variant: "filled"` for the closest Android match where available. Runtime lookup tries the chosen form, the default symbol if different, then `questionmark.square`. Host reports substitutions in `platformNotes`.                                                                                                                                                                                                                                                  |

## Open decisions

All of these are decided (2026-10-09); the table above describes the code, and the open item is simulator verification.

1. Decided 2026-10-09: `inspect` maps to the agent's `get_prototype_status` (see [Inspect](#inspect)).
2. Decided 2026-10-09: a bottom sheet lifts above the keyboard from keyboard-frame notifications
   (see [Bottom sheet and the keyboard](#bottom-sheet-and-the-keyboard)). Still open: a simulator
   check.
3. Decided 2026-10-09: `window.layer: "app"` is accepted and ignored silently on iOS, with no
   warning, so one spec runs on both platforms. The prototype stays at window level alert + 1.

## Expiry

Owner decision 2026-10-09: iOS prototypes expire exactly like Android session prototypes
([Lifecycle and safety](../android/prototype-ux.md#lifecycle-and-safety)).

- **Idle TTL.** Five minutes (300,000 ms; `PrototypeIdleTimer`, settable locally through
  `PrototypeModel.idleTtlMilliseconds`, no wire field). An accepted `show_prototype` (including a same-id
  replace) and a user interaction (taps, edits, a pager page that actually changed) restart it.
  Initial pager reports, a snackbar's own `durationMs` close, `hide_for_capture` and `get_prototype_status`
  do not. A hidden prototype still expires.
- **Disconnect.** The prototype belongs to the host session, not one socket. The agent counts
  authenticated connections (`PrototypeClientTracker`); when the last one closes the prototype is dismissed
  and the uploaded assets are dropped, whether or not a prototype was showing. A `show_prototype` handled
  after that edge is dismissed the same way.
- **Events.** Each expiry emits one `prototype_event` `kind: "dismissed"` with a null `name` and
  `payload: {"reason": "ttl"}` or `{"reason": "disconnect"}`, sequenced from the same per-id ledger as every
  other event (the disconnect event has no socket to reach). `user` and `agent` are unchanged.
- **Not applicable.** `teardown` is never emitted: the agent has no service to unbind, and the prototype
  dies with the app process. There is no `persistence: "device"`, so nothing is exempt from the TTL.
- **Host.** No host change or capability is needed: the host holds one persistent connection per
  launch and already treats any `dismissed` event as removing shown status.

## How it works

1. `ios/prototype-agent/` builds a small simulator-only dylib, ad-hoc signed. It needs no
   Developer ID identity, notarization or provisioning because it only loads into simulator
   processes.
2. The app is launched with `simctl launch` and the child environment variable
   `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` pointing at the dylib. `simctl` strips the
   `SIMCTL_CHILD_` prefix, so dyld loads the library into the app before `main()`.
3. The agent adds a SwiftUI `UIWindow` at window level `.alert + 1`, above the app's own
   windows, and renders the shared prototype spec into it.
4. The window's `hitTest` returns `nil` outside the prototype content, so touches there pass
   through to the app. Floating cards therefore leave the live app usable.
5. The agent listens on a loopback (`127.0.0.1`) TCP socket and speaks the CtrlProxy prototype
   message names (`show_prototype`, `dismiss_prototype`, `put_prototype_asset`, `prototype_result`,
   `prototype_event`) as newline-delimited JSON. There is no `update_prototype` (#10490): a
   `show_prototype` with the id already shown replaces it in place.
6. Each launch gets its own port and a random token. The host passes them as
   `AUTOMOBILE_PROTOTYPE_PORT` and `AUTOMOBILE_PROTOTYPE_TOKEN`; the first frame on a connection
   must be a `hello` carrying the token, and the agent replies with its version and
   capabilities. The agent does not start its server without both values, and the token
   must be at least 16 characters.

Because the window lives inside the app's process, `observe`, `tapOn`, `sendKeys`,
screenshots and video recording all see the prototype the same way they see app UI.

## Limits

- **Simulator only.** On physical devices code signing blocks the injection. Use the in-app
  SDK route for devices.
- **Only apps launched with the agent.** Injection happens at launch, so enabling it for a
  running app means relaunching it, which loses in-memory app state. An app started any
  other way (home screen, a plain `launchApp`, Xcode) has no agent unless you set it up as
  described below.
- **SpringBoard and system UI are not covered**, so the home screen cannot host a prototype.
- Prototypes disappear when the app exits or is relaunched without the agent.
- **Structural limits are re-checked.** The agent does not validate a spec, but it refuses one
  whose expanded tree passes the node (2000), depth (24) or `repeat` item (128) limit of
  `schemas/prototype-spec-contract.json` before expanding it (#11049).
- **Every state write is validated.** A tap, a control's own write, text-field typing and
  `setStates` all go through one validator (`PrototypeStateValidator`) with Android's binding
  rules, and a rejected interaction changes nothing and emits nothing (#11408, #11551, #11562).
  A rejected edit also redraws the text field so it shows the accepted text again. Android
  versions each field's text (`textEpochs`) to drop edits typed against replaced text; the iOS
  field binds the live state on the main actor, so there is no in-flight stale edit to drop.
- **Spec byte cap (difference from Android).** Android re-encodes the whole spec, state
  included, after each write and rejects one over `MAX_PROTOTYPE_SPEC_BYTES` (1 MiB of UTF-8).
  The agent keeps no raw spec bytes, so it measures the shown spec's size outside `state` once,
  from the `show_prototype` request's own `spec` (re-serialized, so whitespace is not counted),
  and adds the candidate state's JSON size to it on each write. A rejection (`Spec byte limit
  exceeded`) is therefore the same up to a few bytes of encoder difference (number spelling,
  default fields Kotlin re-emits). A session built without a request (unit tests) counts the
  state alone.

## Entry point: `launchApp { prototype: true }`

`launchApp` with `prototype: true` on an iOS simulator is the intended entry point (#10567).
It resolves the dylib, allocates a port and token, launches with the `SIMCTL_CHILD_*`
environment, and records the agent against the device and bundle id so `prototype` can
connect. A normal `launchApp` injects nothing. Any `DYLD_INSERT_LIBRARIES` you already set
is preserved. On a physical device the option fails with a simulator-only error.

If `prototype` targets an app that was not launched this way, it fails and tells you to
relaunch with `launchApp { prototype: true }` rather than relaunching on its own, because a
relaunch loses state.

## Where the dylib comes from

The client resolves the dylib in this order (#10565):

1. An explicit path.
2. The `AUTOMOBILE_IOS_PROTOTYPE_AGENT` environment variable, a path to a local build. Use it
   for repository checkouts and development builds.
3. The local build output.
4. A download of the release asset, checksum-verified and cached under
   `~/.auto-mobile/prototype-agent/`.

If there is no pinned checksum for the running build, the client reports that the prototype
agent is unavailable instead of using unverified bytes. Set
`AUTOMOBILE_SKIP_IOS_PROTOTYPE_AGENT_DOWNLOAD` to disable the download.

## Apps launched from Xcode

When you run the app from Xcode, AutoMobile does not launch it, so add the injection to the
scheme yourself:

1. Product, Scheme, Edit Scheme, select **Run**, then the **Arguments** tab.
2. Under **Environment Variables**, add `DYLD_INSERT_LIBRARIES` with the absolute path of the
   dylib: the cached file under `~/.auto-mobile/prototype-agent/`, or the file named by
   `AUTOMOBILE_IOS_PROTOTYPE_AGENT` for a local build.
3. Add `AUTOMOBILE_PROTOTYPE_PORT` and `AUTOMOBILE_PROTOTYPE_TOKEN` (at least 16 characters) with
   values you also give the client, since AutoMobile did not choose them.
4. Run on a **simulator** destination. In a scheme the variable is `DYLD_INSERT_LIBRARIES`
   itself; the `SIMCTL_CHILD_` prefix applies only to `simctl launch`.

Do not enable this on device destinations or in archive/release configurations; the dylib
is simulator-only and device launches will fail to load it.

## Differences from Android

- Successful iOS shows report affected spec paths in `platformNotes` for identifier fallback,
  bottom-sheet swipe-dismiss/detents, unmapped built-in icons, and substituted icon variants;
  the authoring guide lists the differences and the capabilities that lift them.

- Numbers in `{key}` text and `repeat` bindings render exactly as the host's `renderScalar` does
  (`PrototypeScalarText`): integral values as exact plain digits at any magnitude (`-0` is `0`), all
  others as JavaScript `String(number)` (`1e-7`, `1.5e-7`, `0.30000000000000004`).
- `prototype` on iOS has no `showVariants` and no `update` action (removed by owner decision).
  Showing a spec with an id that is already shown updates it in place, keeping each pager's page;
  `reset: true` starts it fresh (the agent advertises `prototype_show_in_place_v1`, and the host refuses
  `reset` on an older agent). For a variant
  carousel, compose the spec yourself and `show` it.
- No `display` selector and no `window.persistence: "device"`; the host refuses them.
  `window.layer: "app"` is accepted and ignored. See [Feature support](#feature-support).
- `inspect` reports the one prototype the agent shows, with no `suspended` and no
  `deviceDroppedEvents` (nothing is persisted or buffered offline). Idle TTL and disconnect
  dismissal match Android; see [Expiry](#expiry).
- Rendering is SwiftUI in the app's process rather than Compose in CtrlProxy, so there is no
  separate accessibility service involved.
- Android reaches any app through CtrlProxy; iOS reaches only apps launched with the agent.

## Inspect

`inspect` (#10494 on Android) asks the device which prototypes it shows and adopts them into the host's
`status` and `awaitEvent` state, for use after a session release or daemon restart. On iOS the host
sends `get_prototype_status` and adopts its reply. The agent holds at most one prototype and dies with the
app, so the report is that one prototype: `id`, `state`, `pages` and `lastSequence` (the agent's event
ledger for the id, so the host resumes past it), with `persistent: false`. The agent also replies
`visible`, whether its window is on screen, which the host does not surface. There is no `suspended`
(the prototype lives in the app, so backgrounding the app hides its window), no offline event replay
and no `deviceDroppedEvents`. A prototype the host lists that the agent no longer shows is dropped.

The agent advertises `prototype_inspect_v1` for the `lastSequence` and `visible` fields. The host
refuses `inspect` on an agent without it, before sending anything, and asks to relaunch with
`launchApp { prototype: true }` to load the current agent.

## Bottom sheet and the keyboard

Owner decision 2026-10-09, matching [Android](../android/prototype-ux.md#bottom-sheet-and-the-keyboard-10262):
a `sheet` with `edge: "bottom"` (or no edge) moves above the software keyboard while it is shown and
returns to the screen edge when it hides. Fullscreen, floating and top sheets never move.

- **Source.** The agent runs in the app's process, so `keyboardWillChangeFrame` and
  `keyboardWillHide` are the notifications of the keyboard the app shows. The lift is how far the
  keyboard's end frame reaches into the prototype window (`PrototypeKeyboardLift.amount`, in the
  UIKit-free core), 0 for a hardware keyboard or a hidden one, and never more than the window.
- **No double lift (#11042).** This lift is the only thing that moves for the keyboard. Both hosting
  controllers (page and top layer) set `safeAreaRegions` to none
  (`PrototypeKeyboardLift.hostSafeAreaRegions`) and the root view ignores every safe-area region, so
  neither UIKit nor SwiftUI adds its own keyboard inset; floating prototypes do not move, as on Android.
  On an iOS 26.5 simulator the root's `ignoresSafeArea(.keyboard)` alone still let a 300 pt sheet
  move 527 pt for a 334 pt lift. Core tests pin sheet bottom == keyboard top, including for a window
  with a non-zero origin and a shorter height.
- **Touch and clip.** The sheet's content is padded up by the lift inside its full-window frame, so
  its reported touch rect moves with it, and the anchor layer's clip region is computed with the same
  lift (`PrototypeSheetFrame.rect(lift:)`), so anchored nodes and their touch targets stay in sync.
- **Motion.** The move animates over the keyboard's own duration, with an ease-in-out curve (UIKit's
  private keyboard curve is not public API). It is instant under spec `motion: "none"` or Reduce
  Motion (`PrototypeKeyboardLift.animationDuration`).
- **Not yet verified on a simulator.** No simulator was driven for this change.

## Light and dark values

The agent advertises `prototype_theme_modes_v1` (#11220, part of #11215), so the host sends it the
per-mode spec forms. The rules below are the Core target's (`PrototypeModeValue`,
`PrototypePalette`, `PrototypeGradient`, `PrototypeThemeModes`), covered by `swift test`; the
drawing itself is not yet device-verified.

**Which mode.** One mode is resolved per shown prototype, and every per-mode value follows it. The
order, and what the agent reports about it, is in [Appearance](#appearance).

**Colours.** Every colour slot takes a hex value, a role name, or `{light, dark}` whose sides are
each a hex value or a role: `style.background`, `style.color`, `style.shadowColor`,
`style.border.color`, a `styleWhen` entry's style, gradient stop colours, `window.placement.scrim`
and a bottomSheet `scrim`. A pair gives its side for the resolved mode; that value is then
resolved like a single one, so a role comes from the resolved mode's scheme.

**Theme role maps.** The scheme is built in this order: the baseline Material scheme for the
mode, the seed scheme, the flat `theme.colors.<role>` overrides (both modes), then
`theme.colors.light` or `theme.colors.dark` for the resolved mode. A mode map never takes part in
choosing the mode. A top-level `theme.colors` key that is neither a field nor a role is not
applied and is logged once per show.

**Gradients.** `style.gradient` is painted over `style.background` and under the content, inside
the node's corner shape. The geometry matches Android: a linear gradient's angle is degrees
clockwise from left to right (0 runs left to right, 90 top to bottom) and its line passes through
the centre, long enough that the corners take the first and last stop colours; a radial gradient
starts at the centre and reaches the corners. Positions apply only when every stop has one, and
are made non-decreasing; otherwise the stops are spread evenly. A `card` and a `topAppBar` drop
their default container when the node has a gradient, as they do for a background.

**Scrims.** `window.placement.scrim` and a bottomSheet's `scrim` resolve through one function,
`PrototypePalette.scrim` (owner decision 2026-10-10). Only the `scrim` role gets an alpha: named
directly or as the resolved side of a pair, it draws the scheme's scrim colour at 40% opacity
(`PrototypePalette.scrimRoleAlpha`, the same number as Android's `PROTOTYPE_SHEET_SCRIM_ALPHA`),
because the role itself is opaque black. Any other role used as a scrim draws its colour
unchanged, and a hex value keeps exactly the authored alpha. Outside a scrim slot the `scrim`
role is the plain colour. A bottomSheet's authored `scrim` takes the touches it covers, and a tap
on it closes the sheet by writing `!equals` to its `openWhen` key, as on Android.

**Known differences from Android.**

- A bottomSheet without a `scrim` draws nothing behind the sheet. Android draws its default
  scrim (the `scrim` role at 40%).
- A bottomSheet's scrim covers the sheet node's own frame, behind the sheet surface, not the
  whole prototype window: the iOS renderer draws a sheet in place instead of hoisting it above the
  tree.
- A `button` keeps its system fill, which covers a `style.gradient` behind it. Android makes the
  button's container transparent so the gradient shows.

**Images.** `image.asset` and a `tabBar` / `bottomNav` item `image` take an asset id or
`{light, dark}` ids; the id for the resolved mode is drawn. A nav item draws its image at 24 pt
when the asset is uploaded, then its `icon`, then a placeholder square. Both ids of a pair are
reported in `missingAssets` until they are uploaded.

**Malformed values.** The agent has no copy of the host validator. For the forms this capability
added it checks them while decoding, and a malformed one fails `show_prototype` with
`Invalid prototype spec: <path>: ...`, leaving the shown prototype untouched: a pair that is not
exactly `{light, dark}` strings, a pair side or a gradient stop or a scrim that is neither a hex
value nor a role, an empty id in an image pair, a gradient with an unknown type, a linear one
without an angle, fewer than two or more than four stops or a position outside 0 to 1, and a
`theme.colors.light` / `dark` that is not a non-empty `{role: hex}` map. Every shared invalid
fixture for these forms fails on iOS (`PrototypeThemeModesTests`). Two things stay with the host
alone: the image-count limit (the agent has none, and a spec over it draws correctly), and a
single unknown value in a slot that predates the capability (a style colour, a border or shadow
colour), which draws that slot's fallback as before.

## Appearance

The agent advertises `prototype_appearance_v1` (#11222, part of #11215). The rules are the Core
target's (`PrototypeAppearance`, `PrototypeSession`), covered by `swift test`; the UIKit side is not
yet device-verified.

**Resolution order.** The same on Android (#11215 D4, owner decision 2026-10-10). The first that
applies decides the mode, and names the `source` the agent reports:

| Step | Decides                                                            | `source`             |
| ---- | ------------------------------------------------------------------ | -------------------- |
| 1    | `theme.mode` `light` or `dark`                                     | `explicit`           |
| 2    | Luminance of the flat `theme.colors.background` (else `surface`)   | `roleLuminance`      |
| 3    | The first opaque authored background on the root's leading chain   | `authoredBackground` |
| 4    | The system setting: the show's `appearance` when `light` or `dark` | `override`           |
|      | else the simulator's appearance                                    | `system`             |

The override replaces the simulator's setting only, so it never beats what the spec itself says: a
spec with no mode and a white root shown with `appearance: "dark"` is light, from
`authoredBackground`. `override` is reported only when the override decided the mode.
`theme.mode: "system"` asks for the system setting outright, so it skips steps 2 and 3. A surface
is dark when its luminance is below 0.179, as on Android.

**Authored background.** Step 3 is Android's `prototypeAuthoredTheme`. The leading chain is the
root, then its first visible child, and so on; a pager continues into its current page, and a
single-child node into its `child`. A node hidden by `visibleWhen` paints nothing and is skipped.
The background is the node's style with every matching `styleWhen` merged in. Only a single hex
value with alpha of at least 0.99 decides: a role name and a `{light, dark}` pair depend on the
mode, so neither can infer it, and the search continues below them. `theme.colors.light` / `dark`
never take part either. Unlike Android, the inferred background is not painted over the scheme's
surface roles; it only picks the mode.

**Override.** `show_prototype` takes a request-level `appearance`: `device` (the default, also
when the field is absent), `light` or `dark`. It belongs to that show: a later show without it
follows the simulator again. Any other value fails the show with
`appearance: Expected device, light or dark` and leaves the shown prototype untouched. The
simulator itself is not changed, so the app behind keeps its own appearance.

**One mode for everything.** `PrototypeSession.appearance` is derived from the spec, the current
state and pages, the override and the simulator's appearance. The palette, the host chrome (the
dismiss bar and close chip), scrims, per-mode colours and images, the SwiftUI `colorScheme` and
the window's UIKit trait all read that one value. A state change that changes the inferred
background (a `styleWhen`, a `visibleWhen`, a pager page) therefore moves all of them together.

**UIKit trait.** The prototype window's `overrideUserInterfaceStyle` is set to the resolved mode,
so UIKit-backed pieces (a text field's keyboard, dynamic `UIColor`s) match what SwiftUI draws.
Because the window is overridden, the simulator's appearance is read from the window scene's trait
collection instead, and the agent does not adopt an app window's own override (#11215 Q1).

**Live re-theme and the event.** The agent registers for `UITraitUserInterfaceStyle` changes on
the window scene. A change re-resolves the shown prototype, keeping its state and pages. Whenever
the resolved mode of a shown prototype changes, the agent pushes exactly one `prototype_event`
with `kind: "appearance_changed"`, `name: null` and `payload: {mode, source}`, sequenced like any
other event. That covers the simulator flipping, and a state change that moves the inferred
background; for the latter the event follows the `change` or `page_changed` that caused it
(`PrototypeSession.transition`). There is no event when the mode stays as it was (an explicit
mode, a repeated report, a state change that leaves the leading background's polarity alone), for
the show itself (its result reports the mode), or with nothing shown.

**Report.** A successful `show_prototype` result and `get_prototype_status`'s `status` carry
`appearance: {mode, source, deviceDark}`: `mode` is `light` or `dark`, `source` is one of the five
names above, and `deviceDark` is the simulator's own appearance whatever decided the mode. The
agent states it in each reply; the host's `prototype` `status` action is host-local and reports
only `mode` and `source`, because a pinned mode sends no event when the appearance flips (#11416). The
status has no `appearance` while nothing is shown.

## Anchors

Node anchors (#9316) work as on [Android](../android/prototype-ux.md#anchors), in points.
The host resolves each element anchor once at show against a fresh hierarchy of the app
alone (the agent's own window, found by the root view's `automobile-prototype-window` marker
only for a chromeless fullscreen prototype, or by the dismiss control for every other prototype
and older agents, is excluded) and sends it as
a bounds anchor. iOS hierarchy bounds are already points, the unit iOS spec sizes use, so
no density conversion happens; the result's `anchors[].boundsPx` and `bounds` carry the
same point values. The host sends anchors only to an agent whose handshake advertises
`prototype_anchor_v1`, and refuses the show otherwise (relaunch with `launchApp
{ prototype: true }` to load the current agent). The agent refuses an element anchor that
reaches it unresolved.

The agent draws anchored nodes in a window-level layer above the spec tree (above its
modal, for a node inside a dialog), so a parent neither reserves a slot for one nor clips
it, and its touch target and accessibility frame are where it is drawn. The layer places
a node at its anchor's screen rectangle less the layer's own screen origin: the prototype
window's screen origin plus the layer's position in the window. With fullscreen `chrome: "none"`
the anchor layer starts at the window top, so anchors are not shifted. With `chrome: "bar"`
the layer sits below the dismiss bar, so anchors are shifted up by the bar and an anchor
under the bar is clipped. `cover` sizes the node to the bounds, ignoring
authored width and height; the edges keep the node's size, align that edge and centre it
on the other axis; `start` and `end` follow the layout direction; `offset` applies last,
in screen axes. Only the root of a floating prototype may be anchored, as on Android; with
no window to move, the layer places the anchored root itself and the rest of the screen
stays touchable. Anchors are resolved once and do not follow later scrolling.

## Material components

The agent draws every component node of the shared vocabulary (#10439) with SwiftUI and
follows Android's behavior for each: what a tap, pick or drag does, the `change` events it
emits, and the `<testTag>.<part>` identifiers of composite parts. The tap semantics live in the
UIKit-free core (`PrototypeComponents.swift`), so the `simulate_tap` test hook performs the same
transition as a real tap, including on a part identifier.

| Node                            | iOS drawing                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `switch`, `checkbox`            | One toggle element with a SwiftUI-drawn track (no `UISwitch`); a checkbox is a button that reads as selected                              |
| `button`                        | `.borderedProminent` filled, `.bordered` tonal/outlined/elevated, `.borderless` text; optional leading SF Symbol from the canonical table |
| `slider`                        | `Slider` with `step` snapping, one adjustable element labelled by `label`                                                                 |
| `chip`                          | Rounded button; a filter chip toggles its key and reads as selected                                                                       |
| `card`                          | Rounded container, filled, elevated (shadow) or outlined                                                                                  |
| `radioGroup`, `segmentedButton` | One button per option, identified `<testTag>.<value>`, with a selected trait                                                              |
| `listItem`                      | One row element; a toggle when it has a trailing switch or checkbox                                                                       |
| `iconButton`, `fab`             | Icon buttons labelled by `contentDescription`, a FAB's `label`, else the icon                                                             |
| `topAppBar`                     | Header title; `<testTag>.navigation` and `<testTag>.actions.<index>` buttons                                                              |
| `divider`, `badge`, `progress`  | Hairline, dot or count capsule, determinate `ProgressView` or ring, indeterminate sweep                                                   |
| `timePicker`, `datePicker`      | Wheel `DatePicker` (one `change` per edit), graphical `DatePicker` in UTC days                                                            |
| `dialog`, `snackbar`            | Drawn above the author tree inside the prototype window; `<testTag>.confirm`, `.dismiss`, `.action`                                       |

A segmented `Picker` cannot carry per-segment accessibility identifiers, so segmented buttons
are drawn as a row of buttons. A dialog's scrim covers the whole window (below the dismiss
bar with fullscreen `chrome: "bar"`) and takes every touch while it is open, even for floating or sheet
placements; a snackbar takes touches only on itself. A dialog's title (a header), text, child
controls and buttons are each their own accessibility element. While a dialog is open the page
behind it (the spec tree and its anchor layer) is collapsed out of the accessibility tree, as it
is inert to touches; `accessibilityHidden` alone did not keep it out of the XCUITest snapshot
(#10899). The dialog itself is not marked modal (#10912). Otherwise each layer is its own
accessibility container, so a page whose only element is one node reports that node at its own
frame, not the whole page's (#10898). Opening or closing a dialog drops keyboard focus in the prototype unless the
dialog holds a text field; a child taller than the screen scrolls. Material icon names map to
SF Symbols using `schemas/prototype-ios-icon-symbols.json` (the authoritative mapped/unmapped
lists, minimum iOS 17.0; the reviewable rendering with every fallback name is
`ios/prototype-agent/ICON-SYMBOLS.md`). An unmapped contract name draws the same `questionmark.square` symbol in every
icon slot. Filled/outlined icon-node variants use their form where the table has one; otherwise,
and for rounded/sharp/twoTone, the default symbol is drawn. With no variant, iOS draws the name's
default SF Symbol, which is often the outline form; pass `variant: "filled"` on an `icon` node for
the closest match to Android where the table has a filled form. The agent advertises
`prototype_icon_sf_symbols_v1` and the host reports affected paths in `platformNotes`. Container
variants on buttons remain container styles. Unknown names from host/agent skew draw no glyph:
icon nodes draw their authored background or placeholder fill; navigation items draw a placeholder
square; other controls omit the icon and its spacing. A navigation item with neither icon nor image
keeps its existing `.none` visual. Runtime lookup tries the chosen form, then the entry's default
symbol if different, then `questionmark.square` if neither is available.

Material parity remains a future option behind `prototype_icon_set_material_v1` and
`prototype_icon_variant_v1`; this agent advertises neither capability and draws no Material artwork.

A snackbar that sets `durationMs` closes itself that long after it opens, by writing `!equals` to
its `openWhen` key like any other close (a plain timer behind an injectable `PrototypeClock`).
Motion matches Android (#10442, #10439): a `visibleWhen` node fades and expands in and out, its
`transition` (`none`, `fade`, `expand`, `slide`) picks the animation, and pager page changes
animate. A `box`, `row` or `column` also animates its size (Android's `animateContentSize`) when a
direct child appears, disappears or resolves to a new width or height, so siblings slide into
freed space; unrelated state changes such as typing do not animate. The animation is scoped to
`PrototypeNode.containerLayoutSignature`, so only layout changes trigger it. Spec `motion: "none"` or
the system's Reduce Motion (`UIAccessibility.isReduceMotionEnabled`) makes every change instant.

The host's dismiss control (`automobile-prototype-dismiss`, "Dismiss prototype") cannot be removed
by the spec. Fullscreen defaults to `window.chrome: "none"`: content and anchors fill the
window, and `safeAreaPadding` sees the real top inset. A host-owned two-finger 1 s long press
anywhere on the window reveals a dismiss pill for 5 s; another hold restarts that deadline.
The two-finger long press on a simulator is not yet device-verified.
Single-pointer taps and swipes cannot reveal it. VoiceOver's escape gesture dismisses directly,
and the pill stays visible under VoiceOver or Switch Control so assistive technology can
activate it. It sits above modals, clears the top safe inset, and `window.opacity` never fades
it. The VoiceOver escape gesture, permanent assistive pill under VoiceOver / Switch Control,
opacity-0 escape, and `automobile-prototype-window` marker's shape in a real capture are
not yet device-verified. The marker is present on the root view only for a chromeless fullscreen
prototype; every other prototype is found by its dismiss control. All these exits dismiss with reason `user`; revealing is not activity for the idle TTL.
The host's dismiss, replacing show, authored dismiss, idle TTL and last-client disconnect keep
working. Back is not the exit.

With fullscreen `chrome: "bar"`, the control sits in a bar across the top of the window:
the bar clears the status bar and cutout, is only as tall as the 44 pt control, is
translucent and follows the spec's light or dark theme, and the spec is laid out below it, so
the control never covers spec content. `safeAreaPadding` inside a fullscreen spec with the bar
therefore sees no top inset. Floating and sheet prototypes keep the control at the window's top trailing
corner.

See the [`prototype` tool reference](../../../tools.md#prototype).

## Data model capability

The agent advertises `prototype_data_model_v1` for the shared
[data model contract](../android/prototype-ux.md#data-model-11673). The host refuses data-model
shows on an agent without it, before uploads or show. The core resolves bindings once per show:
path repeats become projected literal items, authored text placeholders become scalar text, and
data conditions become constant conditions. Decode first guards data, then refuses non-object
authored children before checking two independent node budgets (ordinary nodes and nonempty literal-repeat instances use the expanded budget;
path-bound, empty, or malformed templates use the authored-template budget once) and the depth
limit. It guards `MAX_PROTOTYPE_REPEAT_PATH_CELLS` in container pre-order, then checks
substituted text against both the per-field limit and the 4,194,304 UTF-16 rebuilt-text total per show
(inside a repeat, a data-resolved field is also charged once per item, even without repeat placeholders;
purely literal fields and state placeholders are not charged) and refuses nested repeats before resolving bindings with projected items cached
per pointer, guarding the resolved tree, and expanding repeats. State placeholders are clamped at
substitution to the shared UTF-16 substituted-text limit; literals do not consume that budget.
State interpolation then uses the ordinary expanded tree. `repeat.key` is accepted and kept during
resolution, but rows retain positional identity until keyed patching (#11675).

Data stays agent-owned and read-only except through the data actions below; inspect/status report
it next to state.
Two data keys that are canonically equivalent Unicode strings collapse into one on iOS because
Swift dictionary keys compare by canonical equivalence, unlike the host and Android.
The agent re-checks data depth and array limits in the host's traversal order. It does not duplicate
the host validator's data byte-cost rule at show; the existing 1 MiB whole-spec byte cap still bounds input.

## Data actions capability

The agent advertises `prototype_data_actions_v1` for `setData`, `appendData` and `removeData`
([contract](../android/prototype-ux.md#data-actions-12519)). `PrototypeRepeat` binds a whole `{index}`
path segment and `{item}`/`{index}` values per row at expansion, so a row's action reaches the session
already concrete. `PrototypeSession` resolves the `{value}`, `{state}` or `{data}` value at the action,
applies `PrototypeDataWrite` (a twin of the host's `applyPrototypeDataWrite`, with its `invalid_path`,
`invalid_value`, `not_found`, `not_array` and `limit_exceeded` codes and `MAX_PROTOTYPE_DATA_WRITE_BYTES`),
and rebuilds the drawn tree from the spec's authored root with `PrototypeSpec.replacingData`, so data
text, repeat rows and data conditions refresh and `PrototypeModel` republishes the spec. A write the
tree cannot be rebuilt for within the show's limits is refused like any other.

A refused write changes nothing, emits nothing and does not stop the rest of the action list. An
accepted write bumps the shown id's data revision (monotonic per id, never rewound by a re-show, as
event sequences are) and emits one `change` event whose `name` is the written `/data/...` path (the
array for an append) and whose payload is `{op, value?, revision}`. The value always travels. The agent
does not implement `prototype_patch_v1`, so the revision has no patch conflict check on this platform yet.

## Storage capability

The agent advertises `prototype_storage_v1` and the `clear_prototype_storage` request type (#12526;
[contract](../android/prototype-ux.md#storage-12522)). Stored values live in the host app's own sandbox,
in `Application Support/AutoMobilePrototypeAgent/storage/<id>.json` (`FilePrototypeStorageStore`), never in
the app's own files or its `UserDefaults` domain; the saved-prototype viewer app uses the same code in its
own sandbox. Writes are atomic (`Data.write(options: .atomic)`) and the id is percent-encoded into the file
name, so no id can leave the directory or collide after sanitizing. A file that does not decode (or is far
over the byte limit) is logged, deleted and treated as nothing stored.

`PrototypeStorageCoordinator` is the only code that touches a `PrototypeStorageStore`. `PrototypeModel.show`
calls `prepare` first: `PrototypeStorageRestore` (a twin of the host's `restorePrototypeStorage`) applies the
precedence rules, entries that no longer fit are deleted, and the session receives the restored state and
data through `PrototypeSession.show(_:restoredState:)` before the first draw, with no `change` event and no
data revision bump. After every transition the model calls `sessionChanged`; a listed key whose live value
moved is written on a trailing 400 ms debounce (injected `PrototypeClock`), and a dismissal, the next show,
`get_prototype_status` and the app entering the background or ending flush at once. A write that would take
the id over `MAX_PROTOTYPE_STORAGE_BYTES` still applies live, keeps the key's previous stored value and is
listed in `skippedKeys`. `reset: true` does not clear storage.

`get_prototype_status` (and the standalone `inspect_prototypes` entry) carries a flat
`storage: {version, keys: [{key, bytes}], totalBytes, skippedKeys?}` for a prototype whose spec declares
`storage`. `clear_prototype_storage {id}` answers `cleared`, the number of stored keys removed, and leaves the
shown prototype alone. The iOS saved prototype is its own app, so `deleteSaved` uninstalls the app and its
sandbox, storage included.

## Request action capability

The agent advertises `prototype_network_v1` and `prototype_network_device_v1` for the `request` action
([contract](../android/prototype-ux.md#request-action-12523)). `PrototypeSession` is a twin of the
host's `applyPrototypeRequestOutcome`: a tap resolves the action's bindings against the committed
state and data (`PrototypeRequestResolver`, twin of `resolvePrototypeRequest`; `{key}` and
`{data:/pointer}` are bound in one pass so a substituted value is never scanned again), moves the
`statusKey` to `loading` and issues a start command. The answer arrives later through
`completeRequest`, which writes `into`, then `<into>__meta` (dropping `headers` when the value does not
fit the data write limit), moves the status key, emits the `prototype_request` event and runs
`onSuccess` or `onError`, in that order. A request that cannot be built (an unresolvable binding, an
invalid URL) or is refused (`too_many_in_flight`, at 4) completes at once as an error through the same
path. A newer request to the same `into` cancels the older: the older writes nothing, leaves the status
key alone, runs no follow-up and reports a `cancelled` event (its `durationMs` is 0, because the
session has no clock). Dismissal, a replacing show of another prototype and `reset` cancel every
request; a same-id replace keeps them.

`PrototypeRequestValidator` repeats the host's static rules on the authored tree at show (URL scheme,
method, bodies on GET and HEAD, `into` naming an object member, `statusKey` naming a declared string
state key, header names, entry counts, `timeoutMs` 1 to 30000, follow-up lists of 1 to 32, the reserved
`prototype_request` emit name and `MAX_PROTOTYPE_ACTION_DEPTH`), and `PrototypeRepeat` binds a request's
`url`, `statusKey`, `into`, header and query strings, binding objects and nested follow-up lists per
row. Query entries are set on the URL in sorted key order (UTF-16 code units, the same as JS
`sort()`) on every runtime; the Swift decoder holds `query` as an unordered dictionary, so the rule
is canonical rather than authored order, and the resolved URL and event `url` match the host's. A
string body without an author-set `Content-Type` is sent as `text/plain; charset=utf-8` and any
other JSON body as `application/json`, as on the host and Android.

`PrototypeRequestDriver` runs what the session starts, behind a clock and two seams so its tests are
deterministic:

- **`via: "host"` (the default).** The agent broadcasts a `prototype_request` frame
  (`prototypeRequestMessageSchema`) to the authenticated host connection and the host's
  `prototype_response` frame arrives as an ordinary request line that the agent routes to the driver and
  never replies to. The host has no cancel frame, so a cancelled call is forgotten and its late response
  ignored. A host that stays silent for `timeoutMs` plus 2 s ends as `timeout`; no connected host, or
  the last host leaving, ends it as `network`. The host side is `createPrototypeRequestHost` wired to
  the agent client (`attachIosPrototypeRequests`), which also cancels the device's requests when the
  connection closes.
- **`via: "device"`.** Core owns the `PrototypeHttpClient` protocol and links no HTTP library; the agent
  injects `PrototypeURLSessionClient`. It uses a dedicated ephemeral `URLSession` (never
  `URLSession.shared`, so the app's cookies, cache and credentials are untouched) with the contract's
  30 s ceiling, enforces `timeoutMs` as a total deadline, stops reading a 2xx body and fails with `too_large` once
  it crosses 262144 bytes (or its `Content-Length` announces more; a non-2xx body is never read, so it is
  an `http_error` however large), maps URLSession errors to the
  contract's codes and reports the duration from the task metrics. Its tests run the real client over a
  `URLProtocol` stub.

**Alamofire.** The proposal for #12529 names Alamofire 5.x for the on-device client, after two checks:
that an injected dylib linking Alamofire coexists with a host app that links its own copy, and the
dylib's binary size. Both need macOS, Xcode and a simulator, so they have not been run and the package
does not depend on Alamofire. The URLSession client above is in place behind the same
`PrototypeHttpClient` protocol, which is the fallback the proposal describes; an Alamofire client would
be a second conformance, chosen where the agent builds the driver, with no change to Core.

**App Transport Security.** localhost and IP-literal `http://` hosts are exempt from ATS; any other
cleartext `http://` host falls under the host app's own ATS settings. There is no allowlist. The
viewer template app sets `NSAllowsArbitraryLoads` in `Viewer/Info.plist`, so a viewer runs any URL. In
an injected agent a `via: "device"` request that ATS blocks
(`NSURLErrorAppTransportSecurityRequiresSecureConnection`) completes as a typed `network` error whose
message tells the author to use `via: "host"`, which the AutoMobile host runs without that restriction.

## Text field options

Text fields render via SwiftUI and require `prototype_text_field_options_v1` for the
optional host contract fields. The agent draws `variant: "outlined"` as a rounded outline
around a standard SwiftUI TextField and draws a floating `label` as a non-animating caption
above it. These substituted constructs produce `textField.variant` and `textField.label`
platformNotes until `prototype_text_field_material_style_v1` is advertised (iOS does not
advertise it today). `maxLength` draws a counter and produces no platform note.

Open question: secure values remain in state and `change` events/`inspect`; this slice
does not redact them. Platform implementation follows in a later pass.

## Flow and grid contract (not device-verified)

`prototype_flow_grid_v1` gates `flow` (wrapping row) and `grid`. Both support
children and repeat, with normal node/depth budgets. Flow's optional integer
`maxLines >= 1` clips overflow visually without removing hierarchy children.
`style.spacing` is the item gap; finite nonnegative `style.runSpacing` is the
line/row gap and has the same bounds as spacing (meaningful only on flow/grid).
Grid requires integer `columns` in 1..12 or `{minWidth: dp}` (finite, > 0).
Spacing applies to both axes unless runSpacing overrides the row gap. Grid is
always non-lazy, preserves every child in the hierarchy, and never scrolls
itself; authors wrap it in `scroll`. Row-major placement starts a new row when
a child's span does not fit. Optional integer `span >= 1` is valid only on a
direct grid child and cannot exceed fixed columns; the renderer clamps spans
to the resolved runtime count. Shared fixtures define host validation behavior.

### Optional pager layout

The shared pager contract (#12071) adds `axis` (horizontal by default), `pageSpacing`
(default 0), strict `peek: {start?, end?}` (each default 0; `{}` is a no-op), and
`pageSize` (`"fill"` by default or strict `{dp}`). Distances are finite points on iOS:
spacing and peek are 0..10000, and fixed size is 1e-6..10000 (`MAX_PROTOTYPE_PAGER_DP`).
Any explicit option requires `prototype_pager_options_v1`; the host refuses older agents
with a relaunch hint. iOS renders non-default options with a native view-aligned ScrollView,
lazy horizontal/vertical stacks, scroll content margins and viewport or fixed page frames.
Pagers whose options all resolve to defaults (including explicit horizontal axis, zero
spacing, empty or zero peek, and fill page size) retain the paged TabView / wrap-size drag path. A vertical pager cannot
have any vertical scroll ancestor (omitted scroll axis is vertical). Current page means
the first fully visible page; page events, placeholders and navigation bindings keep
their meaning. Every visible page (including partly visible peek and fixed-size pages) is exposed to accessibility, observe and tapOn; Android marks the current page selected only for pagers with positive peek or a fixed pageSize; iOS marks it selected on the options path (a pager with any non-default option) and not on the legacy paged pager; plain pagers expose only the current page on both. Pages fully off-screen are not exposed.
Indicator and carousel remain deferred.

## Carousel and pager indicator (not device-verified)

`prototype_carousel_v1` gates two additions from #12071. A pager may declare `indicator: "dots"`
(default `none`): page dots drawn over the pager (a centred row at the bottom, or a column at the
end edge for a vertical pager) with the current page filled. The dots are decoration and add no
semantics node.

A `carousel` node is a horizontally scrolling, snapping row with one item per child (at least one;
`repeat` expands like `row`). `itemWidth` (dp, > 0, <= 10000) is required; `variant` is
`multiBrowse` (default), `hero` or `uncontained`; `itemSpacing` is dp >= 0. It has no page index,
event or `setPage` target; use a `pager` when the page matters. The host refuses a show on a
CtrlProxy or iOS agent without the capability before sending it, and the iOS result carries a
`carousel` platform note.

iOS draws every variant as fixed-width (`itemWidth`) items in a horizontal `ScrollView` with
`scrollTargetBehavior(.viewAligned)`; there are no multi-browse or hero size changes, and every
item stays in the accessibility tree. The indicator dots are plain circles (no icons), hidden from
accessibility.

## Pull-to-refresh (`scroll.refresh`, not device-verified)

A vertical `scroll` may declare `refresh: {stateKey, onRefresh}` (1-32 actions in `onRefresh`, the
same union as `onTap`). `stateKey` names a boolean state key that shows the refresh indicator
while it is true; it must be boolean if declared, and a horizontal scroll with `refresh` is
rejected at `<path>.refresh`. A pull writes true to the key (emitting a `change` event) and then
runs `onRefresh`; the prototype's own `setState`, or a `patch` of `/state/<key>` with a
`baseRevision`, writes false to end it. A pull while the key is already true is ignored. Repeat
and component placeholders bind in the key and the actions like `onTap`. The capability is
`prototype_refresh_v1`; the host refuses a show on an older CtrlProxy or iOS agent before sending
it.

iOS draws it with `refreshable` on the `ScrollView`: the closure sets the key, runs the actions
and stays open until the key is false (or the view goes away). A key set true without a pull shows
a plain `ProgressView` at the top, since SwiftUI cannot start `refreshable` programmatically.
Android uses Material `PullToRefreshBox`.

## Text field trailing icon and IME action (not device-verified)

`prototype_text_field_actions_v1` gates textField `trailingIcon {icon, label, onTap?}`, `imeAction`
(`done`, `next`, `search`, `send`, `go`) and `onSubmit` (1-32 actions); multiline text has no IME
action, so the host refuses them with `multiline: true`. iOS maps `imeAction` to `submitLabel` (done
when only `onSubmit` is authored) and runs `onSubmit` from `onSubmit`; the trailing icon is an SF
Symbol button beside the field (a plain glyph without `onTap`), named by `label`, with the
accessibility identifier `<testTag>.trailingIcon` that `tapOn` can target. Android draws an
`IconButton` in the field's trailing slot and uses Compose `ImeAction` with `KeyboardActions`.

## Prototype gesture action lists

`onLongPress` and `onDoubleTap` are optional action lists (1–32 actions, the same union as
`onTap`) on box, row, column, text, image, icon and card only. They require
`prototype_gestures_v1`; the host refuses a show on an older CtrlProxy or iOS agent before sending
it. Each gesture runs its actions like a tap, with no new event kind. Either list makes a node
interactive even without `onTap`. A node with only `onLongPress` and/or `onDoubleTap` does not
consume single taps: the nearest ancestor's `onTap` runs. All three lists may coexist. The
single-tap delay applies only to nodes declaring `onDoubleTap`; `onTap` with only `onLongPress`
fires immediately. Long-press uses the platform default
(about 0.5 s on iOS versus the Android long-press timeout, about 0.4 s).

`tapOn` with `action: "longPress"|"doubleTap"` and `layer: "prototype"` drives them by
coordinate gesture; no new MCP tool is needed. Repeat and component action placeholders bind
as they do for `onTap`.

## Search bar contract (#12069)

The shared `searchBar` node requires a string `stateKey` initialized in state.
It accepts optional `placeholder`, catalog `leadingIcon`, one or two
`trailingActions` (`{icon, label, onTap?}` with a nonempty accessibility label),
boolean-state `activeKey`, `variant` (`bar` by default or `docked`), `onSubmit`
actions and a single `child`. A child requires activeKey; true shows it. Bar
expands to fill its parent; docked stays in place with results under the field.
Typing shares the text-field state-write and `change` event path; keyboard search
runs onSubmit. A visible bar counts as a text field for focus and host sendKeys.
All ordinary child/action validation and template walks apply.

The later iOS agent implementation must advertise `prototype_search_bar_v1`.
Until then the host refuses show and patch results using searchBar before any
device request. SwiftUI draws the field in the prototype window: leading
magnifying glass, text field, clear button when nonempty, and trailing actions.
Do not use `.searchable`, which requires a NavigationStack. Icons map through the
existing SF Symbols mapping and never use Android Material glyphs. `platformNotes`
reports the drawn-field and SF Symbol differences. Results are ordinary observable
child nodes inside the prototype window, not a separate popup/dialog or a lazy
list that drops rows.

## Rich text

A text node has exactly one of `text` or `spans`; plain `text: ""` remains valid.
Spans are strict `{text, style?, onTap?}` objects with nonempty, untrimmed text; whitespace is valid.
Span style accepts only color, fontWeight, fontStyle, textDecoration, textSize, letterSpacing,
fontFamily and background, with the same ranges as node style; background is a colour, never a gradient.
There are no span ids, testTags, visibility conditions, nested spans or URLs.
Each span uses the same state `{key}`, data `{data:/pointer}`, repeat `{item.field}` / `{index}`
and component `{props.x}` binding as node text; span actions bind like node onTap actions.
The resolved texts concatenate in order without separators: observe and accessibility show the
full plain text (an explicit node contentDescription still overrides its accessible label).
Spans do not count as nodes and require `prototype_rich_text_v1`; older devices are refused before show.
A tappable span is part of the text node, not a separate accessibility node, and runs actions without opening URLs.
On Android, activate it with `tapOn {accessibilityLink:"<span text>"}` or
`tapOn {text:"<full plain text>", subtext:{text:"<span text>"}}` without `layer`:
these selectors act across windows because tapOn refuses layer with accessibilityLink/subtext (#9305).
Use `tapAt` on the span bounds as the fallback.
On iOS, links are drawn as links and tap-through is by `tapAt` only; show reports the
`rich-text-links` platform note for tappable spans because there are no separate accessibility elements or semantic links.

Owed device checks (later platform passes): advertise the capability only after renderer support;
verify mixed span styles, resolved concatenated observe text, per-span actions without URL navigation,
Android semanticLinks and both selectors across windows, and iOS tapAt-only links plus platformNotes.
The shared contract caps spans at 64 per text node. Host tests do not verify device rendering.

## Menu and select

`menu` and `select` require `prototype_menus_v1`; the host refuses them before showing or uploading assets when the connected renderer lacks it.

A `menu` requires `openWhen: {key, equals}` with a boolean equality and 1–16 strict `items`. Each item is `{label, icon?, trailingText?, enabled?, onTap?}` or exactly `{type:"divider"}`. Labels and trailing text are nonempty, icons use the existing icon names, and `onTap` has 1–32 existing actions. A disabled item is dimmed, cannot be tapped and does not close the menu. Dividers are neither focusable nor tappable. The elevated surface is anchored to its parent’s bottom end and clamped inside the window. An enabled item or outside tap writes `!equals` to the open key; item actions run after closing.

A `select` requires a string `stateKey` and 2–32 `{value,label}` options with unique nonempty values and nonempty labels; its optional label is nonempty. It shows the current option’s label, or empty text when no option matches, and a trailing expand indicator. Expansion is local view state. Choosing an option writes the string key, emits the same `change` payload as `radioGroup`, and collapses the list. Tapping the field again or outside also collapses it. Both nodes support repeat templates and reusable `use` components: state keys, menu item labels/trailing text/actions and select labels/option labels bind placeholders.

Rendering stays inside the prototype window on both platforms so `observe` and `tapOn` reach the normal hierarchy. Android uses an in-window surface rather than a separate DropdownMenu/Popup window. iOS uses an in-window list rather than system SwiftUI Menu/Picker popups; successful iOS shows report this substitution in `platformNotes`. Menu icons use the existing SF Symbols mapping on iOS.

The select field and menu surface carry the node `testTag`. Select option rows use `<testTag>.<value>`; menu item rows use `<testTag>.<index>`, with zero-based positions including dividers. Android adds row tags only when `testTag` is set; iOS falls back to `(testTag ?? id).<value>` or `(testTag ?? id).<index>`.

## Saved prototype on-disk layout (#12254)

One saved prototype lives in the viewer app container:

```text
Documents/prototype/
  manifest.json
  spec.json
  assets/<sha256>.png|jpg|webp
  fonts/<sha256>.ttf|otf
```

Same-id `show` write-through replaces only `spec.json` inside the layout, and only when the layout was loaded.

Version 1 has the strict manifest shape
`{"formatVersion":1,"specFile":"spec.json","assets":[{"id":"image","file":"assets/<sha256>.png","sha256":"<sha256>","mediaType":"image/png"}],"fonts":[]}`.
Both arrays are always present. SHA-256 is lowercase hexadecimal over file bytes;
identical bytes with the same media type share one content-addressed file. Paths
must exactly match the media type, folder and hash. IDs are unique across both arrays.
The shared asset contract caps count, per-file size and total bytes; spec and
manifest caps are 1 MiB and 256 KiB respectively.

The host writer stages a sibling `.tmp-<token>` directory, writes the manifest last,
then renames into place. Replacement first backs up the old directory to
`.old-<token>` and restores it if the commit rename fails. Callers serialize writes.
The reader refuses unknown versions before validating version-specific fields and
never changes any files. A bad manifest, spec, count or verified-byte total is corrupt;
missing, unreadable, unsafe, empty/oversized or hash-mismatched assets are omitted
from the verified snapshot and reported as sorted problems. The viewer can use its
missing-asset placeholder and expose those problems through `inspect`.

Unlike Android's many slug directories, iOS stores one prototype and has no manifest
id, label or savedAt. Asset failures leave the prototype loadable; reading never
repairs or deletes it. The writer permits spec references absent from the request;
the reader reports these as missing manifest entries. The installer is separate (#12256).

The implementations are `src/features/prototype/savedPrototypeLayout.ts` and
`ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeSavedLayout.swift`.
Both test suites consume `test/fixtures/prototype-saved-layout/layout.json`, including
the same expected manifest and file hashes. Fixture binaries are generated at test time.

## Viewer template release asset

Release automation also ships `AutoMobilePrototypeViewer.zip`, containing a single
top-level `PrototypeViewer.app/` directory. The universal arm64 + x86_64 simulator
app is ad-hoc signed by `scripts/ios/prototype-viewer-build.sh`, then packaged with
`ditto -c -k --keepParent` by `scripts/ios/build-prototype-viewer-release.sh` to
preserve its executable mode and signature. `build-prototype-viewer.yml` verifies
both architectures, `MinimumOSVersion`, the signature, and the absence of
`Assets.car`, `InfoPlist.strings`, and `CFBundleIconName` before uploading it.

Prepare Release records the archive SHA-256 in `prototypeViewerSha256` alongside
`prototypeAgentSha256`, verifies the downloaded candidate archive against that
pin, and includes `prototype-viewer` in artifact provenance. Release reuses that
verified artifact and publishes its checksum in the release notes. Older registry
entries omit the optional viewer pin and resolve to "viewer unavailable". The
host template provider resolves an explicit path, then `AUTOMOBILE_IOS_PROTOTYPE_VIEWER`,
then configured local builds, then a checksum-pinned release cache or download
(unless `AUTOMOBILE_SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD` is enabled).
