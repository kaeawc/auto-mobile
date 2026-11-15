# iOS prototype agent: layout and component contracts

Part of [the iOS simulator prototype agent](prototype-agent.md).

## Text field options

Require `prototype_text_field_options_v1` for the optional host fields. `variant: "outlined"` is a
rounded outline around a standard SwiftUI TextField; a floating `label` is a non-animating caption above
it. These substitutions produce `textField.variant` / `textField.label` platformNotes until
`prototype_text_field_material_style_v1` is advertised (not today). `maxLength` draws a counter, no
note. Secure values remain in state, `change` events and `inspect`, unredacted.

## Flow and grid contract (not device-verified)

`prototype_flow_grid_v1` gates `flow` (wrapping row) and `grid`; both support children and repeat under
normal node/depth budgets. Flow's optional integer `maxLines >= 1` clips overflow visually without
removing hierarchy children. `style.spacing` is the item gap; finite nonnegative `style.runSpacing` is
the line/row gap (same bounds; flow/grid only). Grid requires integer `columns` 1..12 or
`{minWidth: dp}` (finite, > 0); spacing applies to both axes unless `runSpacing` overrides the row gap.
Grid is non-lazy, keeps every child in the hierarchy and never scrolls (authors wrap it in `scroll`).
Row-major placement starts a new row when a span doesn't fit. Optional integer `span >= 1` is valid only
on a direct grid child and cannot exceed fixed columns; the renderer clamps to the runtime count.

### Pager state binding

`pager.stateKey` requires `prototype_pager_state_key_v1` and a declared nonnegative integer
number key. Initial and same-id replacing-show state wins over a retained page; indices clamp
to the page range. Swipes write the key and emit `page_changed` and `change` once; state
writes, patches, `setPage`, and pager-bound navigation share the selection, animated unless
`motion: "none"`. Repeated settled reports are silent. A tab bar can share the key; two
pagers sharing it and pager bindings inside repeat templates are refused. Indicator rows and
conditional styles outside the pager can read the key (see the Android prototype UX example).
Observe continues to expose the current page's nodes.

### Optional pager layout

Shared contract #12071 adds `axis` (default horizontal), `pageSpacing` (0), strict `peek: {start?, end?}`
(each 0; `{}` is a no-op) and `pageSize` (`"fill"` or strict `{dp}`). Distances are finite points:
spacing/peek 0..10000, fixed size 1e-6..10000 (`MAX_PROTOTYPE_PAGER_DP`). Any explicit option requires
`prototype_pager_options_v1`; older agents are refused with a relaunch hint. Non-default options render
with a native view-aligned ScrollView, lazy stacks, scroll content margins and viewport/fixed page
frames; pagers whose options all resolve to defaults keep the paged TabView / wrap-size drag path.

A vertical pager can have no vertical scroll ancestor (omitted scroll axis is vertical). Current page =
first fully visible page; events, placeholders and navigation bindings keep their meaning. Every visible
page (including partly visible peek and fixed-size pages) is exposed to accessibility, observe and
`tapOn`; fully off-screen pages are not. Android marks the current page selected only for pagers with
positive peek or fixed `pageSize`. iOS marks it selected on the options path and not on the legacy paged
pager. Plain pagers expose only the current page on both.

## Carousel and pager indicator (not device-verified)

`prototype_carousel_v1` gates carousels and pager indicator fields. A pager may declare
`indicator: "dots"` (default `none`) and `indicatorPlacement: "over" | "below"`.
Placement applies only with dots; otherwise it is accepted and ignored. iOS defaults to `below`:
a row below horizontal pages or a column beside vertical pages. With `over`, the indicator keeps the
full page size and overlays the bottom or end edge, inset 8 pt. Android defaults to `over`. The current page is
filled; plain circles are hidden from accessibility and hit testing.

A `carousel` is a horizontally scrolling,
snapping row, one item per child (at least one; `repeat` expands like `row`); `itemWidth` (dp, > 0,
<= 10000) required; `variant` `multiBrowse` (default), `hero` or `uncontained`; `itemSpacing` dp >= 0. No
page index, event or `setPage` target (use a `pager` if the page matters). The host refuses a show on a
CtrlProxy or iOS agent without the capability. On iOS, every variant draws as fixed-width items in a
horizontal `ScrollView` with `scrollTargetBehavior(.viewAligned)`, with no multi-browse/hero size
changes and all items accessible. It reports a `carousel` platform note.

## Pull-to-refresh (`scroll.refresh`, not device-verified)

A vertical `scroll` may declare `refresh: {stateKey, onRefresh}` (1-32 actions, same union as `onTap`).
Its `stateKey` must be a declared boolean state key that shows the indicator while true; validation
rejects a horizontal scroll with `refresh` at `<path>.refresh`. A pull writes true (emitting `change`) then runs
`onRefresh`; the prototype's own `setState`, or a `patch` of `/state/<key>` with `baseRevision`, writes
false to end it. A pull while true does nothing. Repeat/component placeholders bind in the key and actions.
Capability `prototype_refresh_v1`; the host refuses older CtrlProxy/iOS agents before sending.

iOS uses `refreshable` on the `ScrollView`: the closure sets the key, runs the actions and stays open
until the key is false (or the view goes away). A key set true without a pull shows a plain
`ProgressView` at the top, since SwiftUI can't start `refreshable` programmatically. Android uses
`PullToRefreshBox`.

## Text field trailing icon and IME action (not device-verified)

`prototype_text_field_actions_v1` gates textField `trailingIcon {icon, label, onTap?}`, `imeAction`
(`done`, `next`, `search`, `send`, `go`) and `onSubmit` (1-32 actions); the host refuses them with
`multiline: true`. iOS maps `imeAction` to `submitLabel` (done when only `onSubmit` is authored) and runs
`onSubmit`. Number, decimal and phone pads have no Return key, so a focused such field shows a keyboard
toolbar button named for the action that runs `onSubmit` and dismisses the pad (#12998). The trailing
icon is an SF Symbol button beside the field (plain glyph without `onTap`), named by `label`, with
identifier `<testTag>.trailingIcon` for `tapOn`. The `leadingIcon`
(`prototype_text_field_leading_icon_v1`) is a decorative SF Symbol before the text, hidden from
accessibility.

## Swipe actions (not device-verified)

`row` or `listItem` `swipeActions: {start?, end?, fullSwipe?}` (`prototype_swipe_actions_v1`). `start`
is revealed by swiping right, `end` by swiping left (sides are physical, not RTL-mirrored). Each side
holds 1-3 entries `{label, icon?, role?, color?, onTap}` (`role` `default` or `destructive`; `color` hex
or role overrides background; `onTap` 1-32 actions); the first entry sits at the screen edge. Release
past 40% of the revealed width, or a fling past open velocity, leaves the row open; dragging beyond
rubber-bands. `fullSwipe: true`: past 60% (or a hard fling) runs the side's first entry and closes.

One row is open at a time; tapping an open row closes it instead of running `onTap`. Revealed buttons get test
tag `<rowTestTag>.swipe.<index>` (start entries first, then end), existing only while open. Every entry
is also an accessibility action (VoiceOver/TalkBack). Reduced motion or `motion: "none"` snaps. Put
swipeActions on repeated rows; inside a horizontal `pager` or `carousel` they are refused (drag
conflict). iOS uses a custom `DragGesture` reveal inside the existing `ScrollView` (not a `List`) with
the same thresholds (`PrototypeSwipe.swift`).

## Prototype gesture action lists

`onLongPress` and `onDoubleTap` are action lists (1-32, same union as `onTap`) on box, row, column,
text, image, icon and card only; they require `prototype_gestures_v1` (host refuses older agents). They
run like taps with no new event kind and make a node interactive without `onTap`. A node with only
long-press/double-tap does not consume single taps: the nearest ancestor's `onTap` runs. The
single-tap delay applies only to nodes declaring `onDoubleTap`. Long-press uses the platform default
(~0.5 s iOS, ~0.4 s Android). `tapOn` with `action: "longPress"|"doubleTap"` and `layer: "prototype"`
drives them by coordinate gesture. Placeholders bind as for `onTap`. Each list is also a named VoiceOver action (`Long press`, `Double tap`; #15123), planned by
`PrototypeGesturePlan.accessibilityActions` and installed with `accessibilityAction(named:)`.

## Search bar contract (#12069)

Shared `searchBar` node: required string `stateKey` initialized in state. Optional fields: `placeholder`,
catalog `leadingIcon`, one or two `trailingActions` (`{icon, label, onTap?}`, nonempty label),
boolean-state `activeKey`, `variant` (`bar` default, or `docked`), `onSubmit` and a single `child` (needs
`activeKey`; true shows it). Bar expands to fill its parent; docked stays in place with results under
the field. Typing shares the text-field state-write and `change` path; keyboard search runs `onSubmit`.
A visible bar counts as a text field for focus and host `sendKeys`.

The iOS agent advertises `prototype_search_bar_v1`; the host refuses shows and patches using
`searchBar` on agents without it, before any device request. SwiftUI draws the field in the prototype window
(magnifying glass, text field, clear button when nonempty, trailing actions); do not use `.searchable`
(needs a NavigationStack). Icons use the SF Symbols mapping. `platformNotes` reports the differences.
Results are ordinary observable child nodes in the window, not a popup or lazy list.

## Rich text

A text node has exactly one of `text` or `spans` (plain `text: ""` stays valid). Spans are strict
`{text, style?, onTap?}` with nonempty, untrimmed text. Span style: color, fontWeight, fontStyle,
textDecoration, textSize, letterSpacing, fontFamily, background (a colour, never a gradient), same
ranges as node style. No span ids, testTags, visibility conditions, nested spans or URLs. Spans use the
same `{key}`, `{data:/pointer}`, `{item.field}`/`{index}` and `{props.x}` bindings as node text; actions
bind like `onTap`. Resolved texts concatenate without separators; observe/accessibility show the full
plain text (explicit node `contentDescription` still overrides). Max 64 spans per text node; spans don't
count as nodes. Requires `prototype_rich_text_v1`; older devices refused before show. A tappable span is
part of the text node, not a separate accessibility node, and runs actions without opening URLs.

On Android activate with `tapOn {accessibilityLink:"<span text>"}` or
`tapOn {text:"<full plain text>", subtext:{text:"<span text>"}}` without `layer` (these act across
windows; `tapOn` refuses `layer` with them, #9305); `tapAt` on span bounds is the fallback. On iOS links
are drawn as links and tap-through is by `tapAt` only; show reports the `rich-text-links` platform note.

## Menu and select

`menu` and `select` require `prototype_menus_v1`; the host refuses them before showing or uploading
assets when the renderer lacks it.

- `menu`: `openWhen: {key, equals}` (boolean equality) and 1-16 strict `items`, each
  `{label, icon?, trailingText?, enabled?, onTap?}` or exactly `{type:"divider"}`. Labels/trailing text
  nonempty; `onTap` 1-32 actions. A disabled item is dimmed, untappable and does not close the menu;
  dividers are neither focusable nor tappable. The elevated surface anchors to its parent's bottom end,
  flipping above the anchor when it cannot fit below but fits above, otherwise clamped inside the window. An enabled item or outside tap writes `!equals` to the open key; item
  actions run after closing.
- `select`: string `stateKey` and 2-32 `{value,label}` options (unique nonempty values, nonempty
  labels; optional label nonempty). Shows the current option's label (empty if none match) and a trailing
  expand indicator; expansion is local view state. Choosing writes the key, emits the same `change`
  payload as `radioGroup` and collapses; tapping the field again or outside also collapses.
- Both support repeat templates and `use` components; placeholders bind in state keys, item labels/
  trailing text/actions, select and option labels.

Rendering stays inside the prototype window on both platforms so `observe`/`tapOn` reach the normal
hierarchy. Android uses an in-window surface, not DropdownMenu/Popup. iOS uses an in-window list, not
system Menu/Picker, and iOS shows report the substitution in `platformNotes`. The select field and menu surface
carry the node `testTag`. Select option rows are `<testTag>.<value>`; menu item rows `<testTag>.<index>`
(zero-based, dividers counted). Android adds row tags only when `testTag` is set; iOS falls back to
`(testTag ?? id).<value|index>`.

## Tooltip and drawer overlays

`prototype_tooltip_v1` and `prototype_drawer_v1` gate `tooltip` and `drawer` respectively in both
strict spec validation and bundle capability discovery. Both use boolean `openWhen: {key, equals}`;
state writes must preserve that binding's type. The generated contract enforces their strict fields.
Tooltip `anchorTo` must resolve to exactly one other node id after host component and repeat expansion.

Tooltips are hoisted into the top hosting layer, outside the page's layout and anchor layer.
`anchorTo` uses the rendered target's global bounds; `anchor` uses host-resolved bounds plus offsets.
An unrendered target leaves state unchanged and draws nothing. The `PrototypePlacement.place` function resolves
caret side, bubble origin and caret offset from target, bubble and window geometry. The `top` side
means the bubble is below the target; logical start/end mirror in RTL. Placement flips to the opposite side
when needed and chooses the larger space when neither fits. It clamps to an eight-point window margin
and keeps the caret aimed at the target center within the bubble's corner inset. Menus use the same
placement module while preserving their bottom-end alignment when they fit below.

A tooltip's optional `spotlight` draws the themed sheet scrim at 40% alpha with an even-odd rounded
cutout, inflated by `padding` (default 8 points; radius default 12). The bubble exposes its text and
`testTag` with a tooltip hint, without a modal accessibility trait. Only a spotlight hides the page
from accessibility and moves focus to the bubble; dismissal restores focus to the anchored node.
Without a spotlight the page remains interactive. Tapping the bubble dismisses unless `onTap` is
present, in which case only those actions run. Spotlight taps (`<testTag>.close`) dismiss. Dismissal
writes `!equals` before running `onDismiss`.

Drawers cover the page with an authored or themed 40% scrim and a surface panel inside the safe area.
Panel width is `min(320, windowWidth - 56)` points; start/end mirror in RTL. The child retains its
normal hierarchy; the panel carries `testTag`, and the scrim carries `<testTag>.close`. Scrim taps,
Back/Escape and outward panel swipes dismiss by writing `!equals`; `dismissOnSwipe: false` disables
swipes. Swipe settling reuses the sheet's half-extent rule. Back closes a drawer before stack navigation
or window dismissal. The page is hidden from accessibility while open; focus enters the panel and
returns to the previously focused element on close.

Drawer entry and exit use a 300 ms linear-out-slow-in slide along the physical edge with a fading
scrim. The modal layer retains closing drawers through animation completion, with a generation guard
for interrupted closes. `motion: "none"` is instant; system Reduce Motion substitutes a crossfade.
Overlay hit frames use the existing `modal.*` host routing, and text and child controls appear in the
normal observe hierarchy. Geometry, dismissal, capability and motion decisions have device-free Core
tests; the renderer uses the existing UIKit focus markers and frame scheduling.
