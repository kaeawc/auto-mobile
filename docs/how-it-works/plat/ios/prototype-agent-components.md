# iOS prototype agent: appearance and Material components

Part of [the iOS simulator prototype agent](prototype-agent.md).

## Appearance

Advertised as `prototype_appearance_v1` (#11222). Rules are Core's (`PrototypeAppearance`,
`PrototypeSession`); the UIKit side is not device-verified.

**Resolution order** (same as Android, #11215 D4); the first that applies decides the mode and the
reported `source`:

| Step | Decides                                                      | `source`             |
| ---- | ------------------------------------------------------------ | -------------------- |
| 1    | `theme.mode` `light` or `dark`                               | `explicit`           |
| 2    | Luminance of flat `theme.colors.background` (else `surface`) | `roleLuminance`      |
| 3    | First opaque authored background on the root's leading chain | `authoredBackground` |
| 4    | System setting: show's `appearance` when `light`/`dark`      | `override`           |
|      | else the simulator's appearance                              | `system`             |

The override replaces only the simulator's setting; it never beats the spec (a no-mode spec with a
white root shown with `appearance: "dark"` is light, `authoredBackground`). `theme.mode: "system"`
skips steps 2 and 3. Dark means luminance below 0.179.

- **Authored background** (step 3, Android's `prototypeAuthoredTheme`). The leading chain is root, then
  its first visible child, etc.; a pager continues into its current page, a single-child node into
  `child`; the chain skips `visibleWhen`-hidden nodes. Background = node style with matching `styleWhen`
  merged. Only a single hex with alpha >= 0.99 decides; the agent skips roles and `{light, dark}` pairs.
  `theme.colors.light|dark` never participate. Unlike Android, the agent does not paint the inferred
  background over the scheme's surface roles.
- **Override.** Request-level `appearance`: `device` (default), `light`, `dark`; scoped to that show.
  Other values fail with `appearance: Expected device, light or dark`. The simulator itself is not
  changed.
- **One mode for everything.** `PrototypeSession.appearance` (from spec, state/pages, override,
  simulator) drives the palette, host chrome, scrims, per-mode colours/images, SwiftUI `colorScheme` and
  the window's UIKit trait. A state change that moves the inferred background moves all together.
- **UIKit trait.** The window's `overrideUserInterfaceStyle` is the resolved mode (so keyboards and
  dynamic `UIColor`s match). Because it is overridden, the simulator appearance is read from the window
  scene's trait collection; the agent does not adopt an app window's own override (#11215 Q1).
- **Live re-theme and event.** The agent observes `UITraitUserInterfaceStyle` on the window scene and
  re-resolves keeping state and pages. Each resolved-mode change pushes exactly one `prototype_event`
  `kind: "appearance_changed"`, `name: null`, `payload: {mode, source}` (following the causing `change`
  or `page_changed`, `PrototypeSession.transition`). No event when the mode is unchanged, for the show
  itself, or with nothing shown.
- **Report.** A successful show result and `get_prototype_status` carry
  `appearance: {mode, source, deviceDark}` (`deviceDark` = simulator appearance regardless of what
  decided). The host's `status` action is host-local and reports only `mode` and `source`, since a
  pinned mode sends no event when the appearance flips (#11416). No `appearance` while nothing is shown.

## Anchors

Node anchors (#9316) work as on [Android](../android/prototype-ux-data-network.md#anchors), in points. The host
resolves each element anchor once at show against a fresh hierarchy of the app alone and sends a
bounds anchor. That hierarchy excludes the agent's own window, found by the root
`automobile-prototype-window` marker for chromeless fullscreen, else by the dismiss control. On iOS, hierarchy bounds are already points, so no
density conversion occurs; `anchors[].boundsPx` and `bounds` carry the same values. The host sends
anchors only to agents advertising `prototype_anchor_v1` and otherwise refuses the show (relaunch hint);
the agent refuses an unresolved element anchor.

The agent draws anchored nodes in a window-level layer above the spec tree (above its modal for a
node in a dialog). A parent neither reserves a slot nor clips, and touch target and accessibility
frame sit where the node draws. The agent places a node at its anchor rect less the layer's screen
origin (window origin plus layer position).

Fullscreen `chrome: "none"`: layer starts at window top, no shift. With `chrome: "bar"` the layer
sits below the bar, anchors shift up by the bar and the agent clips one under the bar. A `cover`
anchor sizes to the bounds ignoring authored width/height. Edges keep node size, align that edge and
centre on the other axis; `start`/`end` follow layout direction; `offset` applies last in screen
axes. Only the root of a floating prototype may be anchored (the layer places it; the rest of the
screen stays touchable). Anchors resolve once and do not follow scrolling.

## Material components

Every component node of the shared vocabulary (#10439) is drawn in SwiftUI with Android's behavior: tap/
pick/drag effects, `change` events, and `<testTag>.<part>` identifiers. Tap semantics live in the
UIKit-free core (`PrototypeComponents.swift`), so the `simulate_tap` test hook performs the same
transition as a real tap, including on part identifiers.

| Node                            | iOS drawing                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `switch`, `checkbox`            | One toggle element with SwiftUI-drawn track (no `UISwitch`); checkbox is a button that reads as selected                                                                      |
| `button`                        | `.borderedProminent` filled, `.bordered` tonal/elevated, `.plain` outlined with an unfilled 1 pt theme-primary capsule stroke, `.borderless` text; optional leading SF Symbol |
| `slider`                        | `Slider` with `step` snapping, one adjustable element labelled by `label`                                                                                                     |
| `chip`                          | Rounded button; filter chip toggles its key and reads as selected                                                                                                             |
| `card`                          | Rounded container: filled, elevated (shadow) or outlined                                                                                                                      |
| `radioGroup`, `segmentedButton` | One button per option, identified `<testTag>.<value>`, selected trait (a segmented `Picker` can't carry per-segment ids)                                                      |
| `listItem`                      | One row element; toggle when it has a trailing switch/checkbox                                                                                                                |
| `iconButton`, `fab`             | Labelled by `contentDescription`, a FAB's `label`, else the icon                                                                                                              |
| `topAppBar`                     | Header title; `<testTag>.navigation` and `<testTag>.actions.<index>`                                                                                                          |
| `divider`, `badge`, `progress`  | Hairline, dot/count capsule, determinate `ProgressView`/ring, indeterminate sweep                                                                                             |
| `timePicker`, `datePicker`      | Wheel `DatePicker` (one `change` per edit), graphical `DatePicker` in UTC days                                                                                                |
| `dialog`, `snackbar`            | Drawn above the author tree in the prototype window; `<testTag>.confirm`, `.dismiss`, `.action`                                                                               |
| `tooltip`, `drawer`             | Hoisted bubble/spotlight or modal side panel; see [Tooltip and drawer overlays](prototype-agent-contracts.md#tooltip-and-drawer-overlays)                                     |

- **Dialog.** Its scrim covers the whole window (below the dismiss bar with `chrome: "bar"`) and takes
  every touch while open, even for floating/sheet placements; a snackbar takes touches only on itself.
  Title (header), text, child controls and buttons are separate accessibility elements. While open, the
  page behind (spec tree and anchor layer) is collapsed out of the accessibility tree, since
  `accessibilityHidden` alone did not keep it out of the XCUITest snapshot (#10899). The dialog is not
  marked modal (#10912). Otherwise each layer is its own accessibility container, so a one-element page
  reports that node at its own frame (#10898). Opening/closing a dialog drops keyboard focus unless it
  holds a text field; a child taller than the screen scrolls.
- **Icons.** Material names map to SF Symbols via `schemas/prototype-ios-icon-symbols.json` (minimum iOS
  17.0). Unmapped names draw `questionmark.square` in every icon slot. Filled/outlined `variant` uses
  that form where the table has one; otherwise, and for rounded/sharp/twoTone, the default symbol (often
  outlined; pass `variant: "filled"` for the closest Android match). Runtime lookup: chosen form, default
  symbol, then `questionmark.square`. Unknown names from host/agent skew draw no glyph. Icon nodes draw
  their background/placeholder, nav items a placeholder square, and other controls omit icon and
  spacing; a nav item with neither icon nor image keeps `.none`. Container variants on buttons remain container
  styles. The agent advertises `prototype_icon_sf_symbols_v1` and neither
  `prototype_icon_set_material_v1` nor `prototype_icon_variant_v1`.
- **Snackbar** `durationMs` closes by writing `!equals` to its `openWhen` key (plain timer behind
  injectable `PrototypeClock`).
- **Stack transitions** advertise `prototype_stack_transitions_v1`. Stack `transition` defaults to
  `platform`; push/replace overrides take precedence. Platform and slide pushes enter from trailing
  over a 30% parallax-shifted outgoing screen; pop and pop-to-root reverse this, mirrored for RTL.
  Platform replace crossfades; explicit fade crossfades and none is instant. Animations use a
  fixed named 300 ms spatial and 150 ms effects timings; the motion-token table is not available. Spec `motion: "none"` is instant; the reduced profile (Reduce Motion
  or `motion: "reduced"`) maps every pattern to crossfade. Session-only change direction, transition and stable entry identities leave
  wire stack snapshots unchanged. Reload resets presentation without animation.
- **Stack patterns.** The `prototype_stack_patterns_v1` capability gates sharedAxisX/Y, fadeThrough,
  zoom and push/replace source. Shared axes compose 30-point directional travel with opacity (X
  mirrors in RTL; both reverse on pop). FadeThrough fades out first, then fades/scales in from 0.92.
  Zoom requires an action source naming exactly one authored sharedKey node inside the target
  stack's screens, exempt from visibility pairing. The `prototype_zoom_transition_v1` capability
  advertises native source-to-root container zoom on Android and native interactive navigation zoom
  on iOS 18+. iOS 17 keeps platform push; older Android agents keep fadeThrough. The zoom capability
  reports rendering only; patterns v1 remains the authoring gate. The `platformNotes` field reports
  OS/capability fallbacks and non-interactive sharedAxisX/Y and fadeThrough pops.
- **Interactive pop.** A simultaneous drag beginning within 20 points of the leading window edge
  scrubs platform and slide, including parallax and dimming. Release commits past half width or when
  predicted end translation passes half width; otherwise it animates back without mutating the
  session. Fade/none retain the 60-point release-to-pop policy, and composed patterns do too. iOS 18
  native zoom owns its interactive pop while a native destination is present, including composed
  screens above it. A native pop removes that destination and its composed segment from the model.
  Replacing the root resets the native origin. Pop targeting follows visible screens and modal
  precedence.
- **Back stack.** Back-stack entries stay mounted, transparent, non-interactive and
  accessibility-hidden, preserving scroll positions on pop within the bounded stack depth; the agent
  releases removed entries after motion.
  Navigation posts a screen-changed accessibility notification targeting the new native screen
  container after layout; accessibility escape uses the same animated pop path. Wrap a stack in a box
  to animate its own visibility.
- **Text content transitions.** Text nodes accept `contentTransition: "numeric" | "crossfade" | "none"` (default `none`). Non-`none` requires `prototype_content_transition_v1`. Numeric changes roll only changed characters up for an increase and down for a decrease; formatting is stripped to digits, the first decimal point and a leading minus. Missing or equal numeric values crossfade; identical text stays still. Spans crossfade as a whole. Roll uses a spring (Android damping 0.8, stiffness 380; iOS duration 0.35 s, bounce 0.15); fades take 200 ms. Accessibility and observe expose the new text immediately. Android reduced motion uses fades and motion off snaps; iOS content transitions snap under reduced motion or motion off.

- **Motion** matches Android (#10442, #10439): `visibleWhen` nodes fade/expand, `transition`
  (`none`, `fade`, `expand`, `slide`) picks the animation, pager changes animate. The `box`/`row`/`column`
  containers animate size (`animateContentSize`) when a direct child appears, disappears or resolves a new
  width/height, scoped to `PrototypeNode.containerLayoutSignature` so typing does not animate. Motion runs
  in the three profiles of the Android design (`PrototypeMotion.profile`: `full`, `reduced`, `off`).
  Spec `motion: "none"` is instant. System Reduce Motion (`UIAccessibility.isReduceMotionEnabled`), the cross-fade preference
  (`prefersCrossFadeTransitions`, iOS 14+) and spec `motion: "reduced"` select
  `reduced`, never `off` (#15244; read through `PrototypeAccessibilityProviding`, faked in tests).
  Under `reduced`, `visibleWhen` transitions other than `none` become crossfades, and container size,
  press scale and swipe-row settles snap. Progress indicators and shimmer rest, while alpha and color
  animations continue (`prototype_reduced_motion_v1`).
- **Shared elements** (`prototype_shared_element_v1` and `prototype_shared_element_v2`):
  `sharedKey` aliases `shared: {key, as: "bounds"}`; the object form and repeat templates require v2.
  Two `visibleWhen` nodes use `matchedGeometryEffect(properties: .frame, isSource:)` in one
  `@Namespace` per hosting root, under `full` only. The `PrototypeSharedElementPlan` type selects frame
  matching for `element` and frame matching plus a crossfade for `bounds`. Both kinds crossfade
  under `reduced` and swap under `off`. Repeat children bind `story-{item.id}` only with
  `repeat.key: "id"`; resolved keys must be unique per side. Unmatched feed items render normally
  and count toward the spec-wide limit of 16 resolved keys.
- **Shared element pairs** cannot nest or cross dialog/bottomSheet boundaries; a pair split across hosting roots
  (for example an anchored window layer) does not match geometry.
  The feed-card-to-detail-column spec in [Shared element morphs](../android/prototype-ux-motion.md#shared-element-morphs-15115-prototype_shared_element_v1)
  is the worked example for both platforms: the repeated card's `story-{item.id}` resolves to
  the detail's `story-one`. Set both to `element` for identical hero content, or `bounds` for
  changing container content. Reduce Motion gives a crossfade; `motion: "none"` gives an instant swap.

### Dismiss control

The spec cannot remove the host's dismiss control (`automobile-prototype-dismiss`, "Dismiss
prototype"). Fullscreen defaults to `window.chrome: "none"` (`prototype_window_chrome_v1`, not yet
device-verified): content and anchors fill the window including under the status bar (use top-edge
`safeAreaPadding`). A host-owned two-finger ~1 s long press reveals a dismiss pill for 5 s (another hold
restarts the deadline; single-pointer gestures can't reveal it; revealing is not TTL activity). The
pill is permanently visible under VoiceOver/Switch Control, sits above modals, clears the top safe inset
and is never faded by `window.opacity`; VoiceOver's escape gesture dismisses directly.

All exits dismiss with reason `user`. Host dismiss, replacing show, authored dismiss, idle TTL and
last-client disconnect keep working; Back is not the exit. Not device-verified: the two-finger press,
VoiceOver escape, permanent assistive pill, opacity-0 escape and the `automobile-prototype-window`
marker shape. That marker is present only on the root of a chromeless fullscreen prototype; the host
finds others by the dismiss control.
Sheet/floating chrome is unchanged (control at the window's top trailing corner). `lastResult.chrome`
reports the effective chrome.

The dismiss control removes a bottom sheet from `inspect` and its content from subsequent `observe` results. A swipe starting on sheet content does not reach the drag surface. A single plan cannot script a grabber drag.

With `chrome: "bar"` the control sits in a translucent 44 pt bar across the top (clears status bar and
cutout, follows the spec's theme). The agent lays the spec out below it, so `safeAreaPadding` sees no
top inset.

See the [`prototype` tool reference](../../../tools.md#prototype).

Style contract fields `style.shadows`, `style.cornerStyle`, `style.border.gradient`,
`scroll.fadeEdges` and `image.filter` require `prototype_style_polish_v2`. The strict
validator accepts these fields and the agent advertises this capability. A shared corner
path clips content and paints backgrounds, gradients, shimmer, borders and shadows;
continuous full radii clamp to half the short side. Shadow layers paint in authored
order within the outer and inner groups, with inner shadows above the border. The
Canvas shadow-only filter avoids painting the spread source itself; its Gaussian
radius is half the authored CSS-like blur. Positive spread expands outer sources
and contracts inner holes. Scroll fades use iOS 17 geometry preferences to mask only
edges with remaining content, mirroring horizontal start/end in RTL; opposing fades
are capped at half the viewport. Image saturation precedes the palette-resolved tint.
