# iOS prototype agent: how it works and limits

Part of [the iOS simulator prototype agent](prototype-agent.md).

## How it works

A fullscreen root defaults each omitted `width` or `height` to `fill`; explicit dimensions (including `wrap`) and size constraints still apply, while floating and sheet roots keep their existing sizing.

1. `ios/prototype-agent/` builds a simulator-only dylib, ad-hoc signed (no Developer ID,
   notarization or provisioning, since it only loads into simulator processes).
2. The app is launched with `simctl launch` and `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` pointing at the
   dylib (`simctl` strips the `SIMCTL_CHILD_` prefix), so dyld loads it before `main()`.
3. The agent adds a SwiftUI `UIWindow` at level `.alert + 1`, above the app's windows, rendering the
   shared spec.
4. The window's `hitTest` returns `nil` outside the prototype content, so touches pass through;
   floating cards leave the app usable.
5. The agent listens on loopback (`127.0.0.1`) TCP and speaks the CtrlProxy prototype messages
   (`show_prototype`, `dismiss_prototype`, `put_prototype_asset`, `prototype_result`,
   `prototype_event`) as newline-delimited JSON. There is no `update_prototype` (#10490): a
   `show_prototype` with the shown id replaces in place.
6. Each launch gets its own port and random token (`AUTOMOBILE_PROTOTYPE_PORT`,
   `AUTOMOBILE_PROTOTYPE_TOKEN`, token at least 16 chars; the agent does not start without both). The
   first frame must be a `hello` carrying the token; the agent replies with version and capabilities.

The window lives in the app's process, so `observe`, `tapOn`, `sendKeys`, screenshots and video all see
the prototype as app UI.

## Limits

- **Simulator only.** On devices, code signing blocks injection; use the in-app SDK route.
- **Only apps launched with the agent.** Injection happens at launch; enabling it for a running app
  means relaunching (losing in-memory state). Apps started otherwise (home screen, plain `launchApp`,
  Xcode) have no agent unless set up as below.
- SpringBoard and system UI are not covered. Prototypes vanish when the app exits or relaunches
  without the agent.
- **Structural limits re-checked.** The agent refuses a spec whose expanded tree passes the node limits (2000 per stack screen, 10000 per spec),
  depth (24) or `repeat` item (128) limits of `schemas/prototype-spec-contract.json` before expanding
  (#11049).
- **Every state write is validated.** Taps, control writes, text typing and `setStates` go through one
  `PrototypeStateValidator` with Android's binding rules; a rejected interaction changes and emits
  nothing (#11408, #11551, #11562). A rejected edit redraws the field with the accepted text. Android
  versions field text (`textEpochs`); the iOS field binds live state on the main actor, so no stale
  in-flight edit exists.
- **Spec byte cap (differs from Android).** Android re-encodes the whole spec after each write and
  rejects over `MAX_PROTOTYPE_SPEC_BYTES` (1 MiB UTF-8). The agent keeps no raw bytes. It measures the
  spec outside `state` once from the `show_prototype` request's `spec` (re-serialized, whitespace not
  counted). It then adds the candidate state's JSON size per write. `Spec byte limit exceeded` therefore
  matches up to a few bytes of encoder difference. Sessions built without a request (unit tests) count
  state alone.

## Entry point: `launchApp { prototype: true }`

The entry point (#10567) on an iOS simulator resolves the dylib, allocates port and token, and
launches with `SIMCTL_CHILD_*`. It connects, retrying refused connections every 200 ms for about 15 s,
because a first launch on a freshly booted simulator can take seconds to bind the listener. It then
records the agent against device and bundle id so `prototype` can connect. A normal `launchApp` injects nothing; an existing `DYLD_INSERT_LIBRARIES` is preserved. On a
physical device the option fails with a simulator-only error. If `prototype` targets an app not
launched this way it fails with a relaunch hint instead of relaunching (that would lose state).

## Where the dylib comes from

Resolution order (#10565): explicit path; `AUTOMOBILE_IOS_PROTOTYPE_AGENT` (local build); local build
output; checksum-verified release download cached under `~/.auto-mobile/prototype-agent/`. With no
pinned checksum for the running build the client reports the agent unavailable rather than use
unverified bytes. `AUTOMOBILE_SKIP_IOS_PROTOTYPE_AGENT_DOWNLOAD` disables the download.

## Apps launched from Xcode

AutoMobile does not launch these, so edit the scheme (Run > Arguments > Environment Variables):

1. `DYLD_INSERT_LIBRARIES` = absolute dylib path (cached file or the `AUTOMOBILE_IOS_PROTOTYPE_AGENT`
   build). In a scheme the variable is unprefixed; `SIMCTL_CHILD_` applies only to `simctl launch`.
2. `AUTOMOBILE_PROTOTYPE_PORT` and `AUTOMOBILE_PROTOTYPE_TOKEN` (at least 16 chars), with values you
   also give the client.
3. Use a **simulator** destination only; never device or archive/release configurations.

## Differences from Android

- Successful shows report affected paths in `platformNotes` for identifier fallback, sheet
  swipe-dismiss/detents, unmapped icons and substituted icon variants.
- Numbers in `{key}` text and `repeat` bindings render as the host's `renderScalar` does
  (`PrototypeScalarText`): integral values as exact plain digits (`-0` is `0`), others as JS
  `String(number)`.
- `prototype` has no `showVariants` and no `update` action. A same-id show updates in place keeping
  each pager's page; `reset: true` starts fresh (`prototype_show_in_place_v1`; host refuses `reset` on
  older agents). For a variant carousel, compose the spec yourself.
- No `display`, no `persistence: "device"`; `layer: "app"` ignored.
- `theme.design` defaults to `platform` (#15244). An `android: {...}` namespace block is ignored with a
  `platformNotes` entry. System Reduce Motion and `prefersCrossFadeTransitions` map to the reduced
  motion profile (crossfades); iOS reports only the horizontal size class (compact, regular).
- `inspect` reports the single prototype, with no `suspended` and no `deviceDroppedEvents`.
- SwiftUI in the app's process rather than Compose in CtrlProxy; no accessibility service.
- Android reaches any app through CtrlProxy; iOS only apps launched with the agent.

## Inspect

`inspect` (#10494) adopts the device's prototypes into host `status`/`awaitEvent` state after a session
release or daemon restart. On iOS the host sends `get_prototype_status` and adopts the reply: `id`,
`state`, `pages`, `lastSequence` (the agent's event ledger, so the host resumes past it) and
`persistent: false`. The reply also carries `visible` (window on screen), which the host does not surface. No
`suspended`, offline replay or `deviceDroppedEvents`. A host-listed prototype the agent no longer shows
is dropped. The agent advertises `prototype_inspect_v1`; without it the host refuses `inspect` before
sending anything and asks to relaunch with `launchApp { prototype: true }`.

## Native presentations and touches (#15463)

A native presentation (`.sheet`, `.alert`, `.confirmationDialog`, `.popover`) presented from the
overlay window's root lives in the prototype window, but no prototype hit rect covers it. So
`PassthroughWindow.hitTest` also claims touches for it, computed at hit time from the presented
controller (`PrototypeNativePresentationHitRegion`). A modal presentation claims the whole window,
so an outside tap dismisses it. A sheet whose selected detent is at or below
`largestUndimmedDetentIdentifier` (`presentationBackgroundInteraction`) claims only its own frame and
lets other touches reach the app. Menus use a system window and need no claim.

## Bottom sheet and the keyboard

Matches [Android](../android/prototype-ux-lifecycle.md#bottom-sheet-and-the-keyboard-10262): a `sheet` with
`edge: "bottom"` (or none) moves above the software keyboard while shown and returns when it hides.
Fullscreen, floating and top sheets never move. The lift animates until the sheet's bottom edge aligns with the keyboard's top edge
(within 1 pt on an iOS 27.0 simulator). An `observe` taken while the keyboard is still appearing sees an
intermediate position, so a check of the lift waits for a stable `observe`.

- **Source.** `keyboardWillChangeFrame` / `keyboardWillHide` in the app's process. The lift is how far
  the keyboard's end frame reaches into the prototype window (`PrototypeKeyboardLift.amount`, UIKit-free
  core): 0 for a hardware or hidden keyboard, never more than the window.
- **No double lift (#11042).** The lift is the only thing that moves for the keyboard. Both hosting
  controllers set `safeAreaRegions` to none (`PrototypeKeyboardLift.hostSafeAreaRegions`) and the root
  ignores every safe-area region; `ignoresSafeArea(.keyboard)` alone is not enough. Core tests pin sheet bottom == keyboard top, including a
  window with non-zero origin and shorter height.
- **Native presentations (#15464).** While a native presentation (`.sheet`, `.popover`) is up from the
  overlay window's root, the lift is 0: UIKit's presentation controller already avoids the keyboard, so
  the agent's lift would stack on it.
- **Touch and clip.** Content is padded up by the lift inside its full-window frame, so the touch rect
  moves with it; the anchor layer's clip uses the same lift (`PrototypeSheetFrame.rect(lift:)`).
- **Motion.** Keyboard duration, ease-in-out (UIKit's keyboard curve is private); instant under
  `motion: "none"` or Reduce Motion (`PrototypeKeyboardLift.animationDuration`).
- **Modal bottom sheet (`bottomSheet` node).** It draws in the top layer, but lays out and scrims
  inside the window's frame for the placement, not the whole screen (`PrototypeModalSheetFrame`). The
  frame is the `sheet` placement's frame (already above the keyboard), a `floating` root's reported frame, or the
  window. Detents are fractions of that frame, and its scrim and `modal.N` touch rect stop at its edge,
  so touches outside a partial-height window still reach the app. In a window that does not itself
  move (floating, fullscreen, top sheet) the frame ends at the keyboard's top edge, so a field in the
  sheet stays visible.
- **Lazy `list` rows.** A modal declared in a lazy list's row template opens. The visible cells
  never draw modals in place, so `openModals` decodes the rows of a list whose template declares a
  modal (`PrototypeLazyModalRows`, cached per row so view identity survives re-renders).

## Light and dark values

Advertised as `prototype_theme_modes_v1` (#11220). Rules are Core's (`PrototypeModeValue`,
`PrototypePalette`, `PrototypeGradient`, `PrototypeThemeModes`), covered by `swift test`; drawing is not
device-verified. One mode is resolved per shown prototype ([Appearance](prototype-agent-components.md#appearance)).

- **Colours.** Every slot takes a hex, a role name, or `{light, dark}` (each side hex or role):
  `style.background`, `style.color`, `style.shadowColor`, `style.shadows[].color`, `style.border.color`, `style.border.gradient` stops, `image.filter.tint`, a `styleWhen` style,
  gradient stops, `window.placement.scrim`, bottomSheet `scrim`. A pair picks its side then resolves
  like a single value (a role comes from the resolved mode's scheme).
- **Theme role maps.** Scheme order: baseline Material scheme for the mode, seed scheme, flat
  `theme.colors.<role>` overrides (both modes), then `theme.colors.light|dark` for the resolved mode. A
  mode map never takes part in choosing the mode. Unknown top-level `theme.colors` keys are ignored and
  logged once per show.
- **Gradients.** `style.gradient` paints over `background`, under content, inside the corner shape.
  Linear angle is degrees clockwise from left-to-right (90 = top to bottom), through the centre and long
  enough that corners take the first/last stop; radial starts at the centre and reaches the corners.
  Positions apply only if every stop has one (made non-decreasing); else stops spread evenly. `card` and
  `topAppBar` drop their default container when a gradient is set.
- **Scrims.** `window.placement.scrim` and bottomSheet `scrim` resolve through
  `PrototypePalette.scrim`; a sheet without `scrim` draws the `scrim` role
  at that 40% like Android's default (`sheetScrim`, #15117). Only the `scrim` role gets alpha: 40%
  (`PrototypePalette.scrimRoleAlpha`, Android's `PROTOTYPE_SHEET_SCRIM_ALPHA`), because the role is
  opaque black. Other roles draw unchanged; hex keeps authored alpha; outside scrim slots the role is the
  plain colour. An authored sheet `scrim` takes the touches it covers; a tap closes the sheet by writing
  `!equals` to its `openWhen` key.
- **Differences from Android.** The scrim covers the sheet node's own frame behind the surface (and
  its safe areas), not the whole window when the sheet is nested (the sheet draws in place rather than
  hoisted). A `button` keeps its system fill, covering a gradient behind it.
- **Images.** `image.asset` and `tabBar`/`bottomNav` item `image` take an id or `{light, dark}`; the
  resolved id is drawn. Nav items draw the image at 24 pt if uploaded, else `icon`, else a placeholder
  square. Both ids of a pair appear in `missingAssets` until uploaded.
- **Malformed values** fail `show_prototype` with `Invalid prototype spec: <path>: ...` and leave the
  shown prototype untouched. Malformed means a pair not exactly `{light, dark}` strings, a bad
  side/stop/scrim, an empty id in an image pair, or an unknown gradient type. It also means linear
  without angle, fewer than 2 or more than 4 stops, position outside 0..1, or a non-`{role: hex}`
  `theme.colors.light|dark`. Shared invalid fixtures all
  fail on iOS (`PrototypeThemeModesTests`). Host-only: the image-count limit, and a single unknown value
  in a pre-existing slot (draws that slot's fallback).
