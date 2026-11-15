# Prototype spec: layout and gesture contracts

Part of [the agent-authored prototype specification](prototype-ux.md).

## Flow and grid contract

`prototype_flow_grid_v1` gates `flow` (wrapping row) and `grid`. Both support
children and repeat, with normal node/depth budgets. Flow's optional integer
`maxLines >= 1` clips overflow visually without removing hierarchy children.
Spacing works like this: `style.spacing` is the item gap, and finite nonnegative
`style.runSpacing` is the line/row gap. It has the same bounds as spacing
(meaningful only on flow/grid).
Grid requires integer `columns` in 1..12 or `{minWidth: dp}` (finite, > 0).
Spacing applies to both axes unless runSpacing overrides the row gap. Grid is
always non-lazy, preserves every child in the hierarchy, and never scrolls
itself; authors wrap it in `scroll`. Row-major placement starts a new row when
a child's span does not fit. Optional integer `span >= 1` is valid only on a
direct grid child and cannot exceed fixed columns; the renderer clamps spans
to the resolved runtime count. Shared fixtures define host validation behavior.

## Carousel and pager indicator

`prototype_carousel_v1` gates carousels and pager indicator fields. A pager may declare
`indicator: "dots"` (default `none`) and `indicatorPlacement: "over" | "below"`.
Placement applies only with dots; otherwise it is accepted and ignored. Android defaults to `over`:
a centred row at the bottom or a column at the end edge, inset 8 dp, preserving the full page size.
With `below`, pages get the remaining space, with a centred row under horizontal pages or a column
beside vertical pages. iOS defaults to `below`. The current page is filled; dots add no semantics node.

A `carousel` node is a horizontally scrolling, snapping row with one item per child (at least one;
`repeat` expands like `row`). Its fields:

- `itemWidth` (dp, > 0, <= 10000) is required.
- `variant` is `multiBrowse` (default), `hero` or `uncontained`.
- `itemSpacing` is dp >= 0.

It has no page index,
event or `setPage` target; use a `pager` when the page matters. The host refuses a show on a
CtrlProxy or iOS agent without the capability before sending it, and the iOS result carries a
`carousel` platform note.

Android maps `multiBrowse`, `hero` and `uncontained` to `HorizontalMultiBrowseCarousel`,
`HorizontalCenteredHeroCarousel` and `HorizontalUncontainedCarousel`; items are clipped with
`maskClip` and only the visible items are composed, so off-screen items are absent from `observe`
until scrolled in. A repeat that expands to no items draws nothing.

## Pull-to-refresh (`scroll.refresh`)

A vertical `scroll` may declare `refresh: {stateKey, onRefresh}` (1-32 actions in `onRefresh`, the
same union as `onTap`). The `stateKey` names a boolean state key that shows the refresh indicator
while it is true; it must be boolean if declared. Validation rejects a horizontal scroll with
`refresh` at `<path>.refresh`. A pull writes true to the key (emitting a `change` event) and then
runs `onRefresh`; the prototype's own `setState`, or a `patch` of `/state/<key>` with a
`baseRevision`, writes false to end it. A pull while the key is already true is ignored. Repeat
and component placeholders bind in the key and the actions like `onTap`. The capability is
`prototype_refresh_v1`; the host refuses a show on an older CtrlProxy or iOS agent before sending
it.

Android draws it with Material `PullToRefreshBox` around the scroll; the authored `testTag` and
size modifiers sit on the box. iOS uses `refreshable`, whose async closure stays open until the key
is false again. A key set true without a pull (an agent patch) shows a plain `ProgressView` at the
top, because SwiftUI cannot start `refreshable` programmatically.

## Chat lists (`prototype_chat_scroll_v1`, #14232)

A vertical `scroll` can be a conversation view:

| Field            | Rule                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reverse`        | Anchors the scroll at the end of its content (Android `verticalScroll(reverseScrolling = true)`), so the newest row is at the bottom and growth keeps the end in view. |
| `stickToEnd`     | A forward scroll at its end follows rows appended to it. A reverse scroll is anchored at its end already.                                                              |
| `atEndKey`       | A declared boolean state key the runtime writes when the end position changes, as a `change` event, for a "new messages" pill.                                         |
| `onStartReached` | 1 to 32 actions run once each time the scroll reaches its start (edge-triggered; a list that fits never fires), for loading older history.                             |

The options need a vertical scroll (`Chat scroll options need a vertical scroll` at the option's
path), and `atEndKey` a declared boolean state key. The action `scrollTo {scroll, to, animated?}`
moves the scroll whose `id` is `scroll`:

- Exactly one scroll may carry that id (`Unknown scroll id`, `Duplicate scroll id` at `.scroll`).
- `to` is `"start"`, `"end"` or `{key: value}`, a `repeat.key` value of a row inside the scroll; a
  key that is not laid out drops the request.
- `animated` defaults to true.

Scrolling is not a state change and emits nothing. A composer is a row with a `textField`
(`imeAction: "send"`, `onSubmit`) and a send `iconButton`, padded with
`safeAreaPadding {edges: ["bottom"], types: ["ime", "systemBars"]}`. Rows off
screen are absent from `observe`; `swipeOn lookFor` still finds them. The iOS agent advertises the
capability too (#14671, SwiftUI `ScrollViewReader` with the same edge-trigger rules).

## Swipe actions

A `row` or `listItem` may declare `swipeActions: {start?, end?, fullSwipe?}` (needs
`prototype_swipe_actions_v1`). Swiping right reveals `start` and swiping left reveals `end`
(mirrored in right-to-left layouts is not done: sides are physical). Each side holds 1-3 entries
`{label, icon?, role?, color?, onTap}`:

- `label` is the button text and its accessibility name.
- `icon` is a built-in icon name (an SF Symbol on iOS).
- `role` is `default` (primary colours) or `destructive` (error colours).
- `color` is a hex or theme role that overrides the background.
- `onTap` is 1-32 actions.

The first entry of a side sits at the screen edge. A release past 40% of
the revealed width, or a fling past the open velocity, leaves the row open; a drag beyond the
revealed width resists (rubber-band). With `fullSwipe: true` a drag past 60% of the row (or a hard
fling) runs the swiped side's first entry and closes the row. Only one row is open at a time, and a
tap on an open row closes it instead of running its `onTap`.

Revealed buttons get the test tag
`<rowTestTag>.swipe.<index>`, counting `start` entries first and then `end`; they exist only while
the row is open. Every entry is also an accessibility action (TalkBack custom action, VoiceOver
action) on the row, so assistive technology can run it without swiping. Reduced motion or spec
`motion: "none"` snaps instead of animating. Put swipeActions on repeated rows; a row inside a
horizontal `pager` or a `carousel` is refused because their drag would compete.

Android drags the row's foreground with `draggable` over the revealed buttons, announces every entry as
a TalkBack custom action and uses the shared swipe thresholds in `PrototypeSwipe.kt`.

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

Each list is also a named TalkBack action (#15123). The `onLongPress` list is the node's long-click
action labelled `Long press` (on a node with `onTap` too, the labelled `combinedClickable` long
click, never a second copy). The `onDoubleTap` list is a custom action `Double tap`, since
TalkBack's own double tap activates `onTap`. The names are
fixed English defaults. The extractor maps only known action ids (`ViewHierarchyExtractor.kt`), so
`observe` may not report these custom actions.

`tapOn` with `action: "longPress"|"doubleTap"` and `layer: "prototype"` drives them by
coordinate gesture; no new MCP tool is needed. Repeat and component action placeholders bind
as they do for `onTap`.

## Search bar contract (#12069)

`searchBar` requires `stateKey` naming an initialized string query. Optional
`placeholder` follows `textField` rules; optional `leadingIcon` uses the same
catalog as `button.icon`. Optional `trailingActions` has one or two
`{icon, label, onTap?}` items, with a required catalog icon and nonempty accessible
label. `onSubmit` is an optional ordinary action list for the keyboard search action.
Typing reuses the text-field state-write and `change` event path. A visible search
bar is a text target and makes the prototype window focusable for the IME.

Optional `activeKey` names an initialized boolean. While true, the optional single
`child` results subtree is shown. A child without activeKey is invalid; activeKey
without a child is valid. `variant` is `bar` (default, expands to fill its parent
while active) or `docked` (stays in place, results directly under the field).
The child, submit actions and trailing actions participate in ordinary validation,
limits, unique ids, state checks, emit-name collection, template binding, anchors
and text-target walks. Repeat placeholders bind in the placeholder and trailing labels.

Show and patch results containing the node require `prototype_search_bar_v1`;
the host refuses them before any device request if it is absent. Android draws
material3 `SearchBarDefaults.InputField` inside an in-tree `Surface`/`Column`
(material3 from `androidx-compose-bom` in `android/gradle/libs.versions.toml`). Results are ordinary rows inside the prototype
window, not a SearchBar popup/dialog or lazy list that drops rows, so `observe`
sees every result row.

## Loading and empty states (#14207, `prototype_loading_states_v1`)

A data condition may test emptiness instead of comparing: `{data: "/feed", empty: true}` holds
when the value is missing, `[]`, `{}` or `""` (`null` cannot be stored in `/data`). With
`empty: false` it holds otherwise. The `empty` field takes the place of `equals`, `notEquals`,
`gt` and `lt` (exactly one is required). Validation rejects `{key, empty}` at `<path>.empty` with
`empty applies only to data conditions`. Like other data conditions, the device resolves it
against the current `/data`, so a request response or data action flips it.

Style `shimmer: true` draws a highlight band sweeping across a `box`, `row`, `column` or `card`
over its background and inside its clip; any other node type is rejected at
`<path>.style.shimmer`. The node reports state description "Loading". With `motion: "none"` or
animator scale 0 no band is drawn. Android also hides the band during the bounded capture hold
renewed by each window-metadata read, so screenshots see the plain placeholder. A `repeat` of literal
placeholder rows makes a skeleton list.

The iOS agent advertises the capability too (#14689). It sweeps the same band (1.2 s, 35% white,
clipped to the node's corner shape) over the node and reads "Loading" to VoiceOver with the
updates-frequently trait. It draws no band under `motion: "none"` or Reduce Motion, and rejects
shimmer on other node types at the same path.
