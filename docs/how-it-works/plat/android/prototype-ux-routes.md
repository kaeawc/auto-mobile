# Prototype spec: screen map and route transitions

Part of [the agent-authored prototype specification](prototype-ux.md).

## Screen map (#14125)

`prototype {action:"screenMap", spec | specPath}` is host-only (no device request). It walks the
spec, after component expansion, and returns `screenMap {nodes, edges}` plus a `mermaid` flowchart.
Nodes are the root, each `stack` screen (`stack:<id>/<screen>`, `start` on the start screen), each
`pager` page (`pager:<id>/<index>`, labelled from a `tabBar` or `bottomNav` that names the pager),
`bottomSheet` and `dialog`. Edges are `push`, `replace`, `pop`, `popToRoot` and `setPage` actions, from
the enclosing screen, each tagged with the `testTag`, `id` and text or label of the node that runs it
and its spec path. A screen node carries the `testTag` of the node that draws it. A `pop` targets
`back` (the previous screen is runtime state), and `setPage` with `next` or `prev` keeps the authored
word. `visibleWhen` alternatives and sheet or dialog opening by state are not resolved.

`getNavigationGraph` (debug-gated with the rest of that tool) diffs the map against the app's recorded
graph when given `prototypeSpec` or `prototypeSpecPath`, and returns `prototypeDiff`. A prototype screen
matches a real screen through, in order: an explicit `screenMapping` (or `screenMappingPath`) entry from
prototype screen id to real screen name; its `testTag` equal to the real screen name; or its stack
screen key (whole, slashes included), tab label or sheet/dialog id equal to the real name ignoring
case and punctuation, with or without a trailing `Screen`, `Activity`, `Fragment`, `Page`, `View` or
`Controller` on either side, so `Overview` still meets `OverviewActivity`. Letters of any script count;
a name with none never matches. A mapped screen never falls
back to the other rules, and a mapping to a name the graph lacks reports `mappedScreenMissing`. The root
is a destination only when the mapping names it. The result lists `matched` screens,
`unmatchedPrototypeScreens`, `unmatchedRealScreens`, `observedTransitions`, `unobservedTransitions`
(`unmatchedScreen`, `dynamicTarget` for `back` and `next`/`prev`, or `notObserved`) and
`ignoredMappings` (keys naming no prototype screen). The live cross-check against `screen_changed`
events from an explored prototype is not built.

## Route contract

`prototype_routes_v1` gates stack `routes`, push/replace `params`, pop `force`, `setStack`,
route placeholders and `stack:<id>` storage keys. CtrlProxy, the embedded renderer (saved
prototypes, ProtoViewer, disposable apps) and the iOS prototype agent advertise it; the host refuses
these fields against a device that does not, so an older runner fails closed. `screens` remains a
map of bare nodes; the optional sibling `routes` map may contain only screen names of that stack.
Each route has optional `params: {name: "string"|"number"|"boolean"}` (at most 16, path-key
names), `onEnter` and `onBack` (1–32 actions each, with the existing action nesting budget). The
start screen cannot declare params because initial display and popToRoot cannot supply them. Param
names use the uncapped path-key identifier grammar; bound state keys are checked by the runtime.

Push and replace accept up to 16 scalar literals or existing state/data/item/index value bindings
in `params`. All declared params are required; unknown names and incorrectly typed literals are
rejected at the action. `setStack {stack, path:[{screen,params?}]}` validates each entry the same way
and requires 1–MAX_PROTOTYPE_STACK_DEPTH entries. A non-forced pop of the owning stack in
its screen's onBack list, including nested timer and request follow-ups, is rejected; `force:true`
bypasses that guard. Pops in dialog actions are independent. An onEnter list cannot push or replace
its own screen, including through nested action lists. `{route.name}` uses the repeat tokenizer
and bindable fields, condition operands and whole data-pointer segments. Its name must be declared by the enclosing screen; lifecycle actions
use their named screen's scope. A nested stack's screen establishes its own scope. The `route` repeat
alias remains valid in specs without route features; route-enabled specs reserve it for params.

Runtime (shared by `PrototypeRuntime` on Android and the iOS session; pure helpers in
`PrototypeRouteRuntime` and its Swift twin):

- Each path entry is `{screen, params}`. Push, replace and setStack resolve bindings when the action
  runs (`{item}`/`{index}` were bound to the row when the repeat was instantiated) and must match
  the route's declarations exactly after resolution; otherwise the action leaves the stack
  unchanged. Popping restores the entry below with its own params.
- `{route.name}` binds each screen's subtree in the stack path to that screen's topmost entry's
  params, and its onEnter/onBack lists to the entry's params when they run: text renders the value,
  a whole-placeholder operand keeps its type, and a whole data-pointer segment takes the value
  escaped per RFC 6901. Binding happens before `/data` resolution; `{index}` is left for the repeat
  that owns it. Screens outside the path are not bound.
- `screen_changed` is emitted once per navigation when the top screen, depth or top params change,
  with `params` beside `screen` and `depth` only when the top entry has params. The new top screen's
  onEnter runs after that event. Each stack's first screen also enters once per show (not on a
  stack whose path a same-id show kept; a stack new to that show still enters). Lifecycle lists
  nest at most 8 deep, so cross-screen onEnter cycles end.
- System Back, the iOS edge swipe and a non-forced authored `pop` run the top screen's `onBack`
  instead of popping when the stack is above depth 1; `pop {force:true}` always pops, so a confirm
  that leaves must use it. A screen with onBack shows no predictive-back preview.
- Status, inspect and events keep `stacks.<id>.path: string[]` and add `params: object[]` parallel to
  it when any entry has params.
- A listed `stack:<id>` key stores the path as `[{screen, params?}]`. The storage restorer checks
  its shape on Android; the runtime restores it when every screen exists and every entry's params
  fit, and otherwise starts the stack at `start` and records that path over the stale one. On a fresh
  iOS show, the restorer also checks screens and param types, drops a stale key as `mismatch`, and
  the coordinator removes it rather than recording the start path. A same-id show's
  kept paths win over storage. Restoring emits no `screen_changed`; the restored top's onEnter runs
  as the show's first entry.

## Stack transitions

`prototype_stack_transitions_v1` gates every explicit stack `transition` and push/replace
`transition` override. Omission means `platform`; pop/popToRoot have no override. The contract
is validated by both agents, and both advertise the capability.

| Value         | Platform behaviour                                                                |
| ------------- | --------------------------------------------------------------------------------- |
| `platform`    | Native navigation animation (default).                                            |
| `slide`       | Directional screen slide, reversed on pop.                                        |
| `fade`        | Screen crossfade.                                                                 |
| `none`        | Instant screen change.                                                            |
| `sharedAxisX` | Sibling steps along a horizontal flow; 30dp travel plus fade.                     |
| `sharedAxisY` | Sibling steps along a vertical flow; 30dp travel plus fade.                       |
| `fadeThrough` | Unrelated destinations; outgoing fade, then incoming fade and scale from 0.92.    |
| `zoom`        | Item-to-detail container transform from the source key into the destination root. |

The four named patterns and push/replace `source` require `prototype_stack_patterns_v1`.
Zoom requires `source` on each push/replace using it, naming exactly one node's `sharedKey` or literal `shared.key`
inside the target stack's screens. A key referenced as a zoom source is exempt from the two-node visibility-pair rule;
repeat templates remain disallowed.
With `prototype_zoom_transition_v1`, Android shares bounds from the outgoing source to the incoming
root and iOS 18+ uses native navigation zoom. Older agents use fadeThrough on Android or platform
push on iOS 17, reported in `platformNotes`. The rendering capability does not add an authoring
requirement: `prototype_stack_patterns_v1` still accepts zoom and source.
Platform, slide and zoom support interactive iOS edge pop; only the composed sharedAxisX/Y and
fadeThrough patterns pop non-interactively. Fallback notes are returned on both platforms.
Android predictive back scrubs every pattern, including the zoom transform, and restores the current
screen on cancellation. PopToRoot reverses the entry edge immediately above the returned screen, using that edge's zoom source rather than the topmost entry's source; without a zoom edge it uses the stack's declared pattern.
Shared-axis pop reverses travel; only X also mirrors for RTL. iOS composes axis movement with
opacity and fadeThrough removes the outgoing screen visually before revealing the scaled incoming
screen. Fixed named timings are 300 ms for movement and 150 ms for fade effects (two sequential
phases for fadeThrough); the motion-token table is not available.

Android slides enter from the end edge with 30% outgoing parallax, mirrored in RTL; pop and
popToRoot reverse that direction. Platform replace crossfades. Animations finish within 300 ms.
`motion: "none"` and animator duration scale 0 snap immediately. The reduced profile (see Motion
profiles) changes every pattern to a crossfade.

Activity hosts scrub the pop with predictive back on API 34+, settle on commit, and restore the
current screen on cancellation. Earlier APIs pop with the ordinary animation. Overlay windows
and authored actions use ordinary transitions. Each path entry owns its scroll offsets, retained
while covered and discarded on pop, replacement or removal. Settled screen containers expose
`paneTitle`; outgoing content leaves composition and semantics after the animation.

Stack transitions, including a predictive-back scrub, count in the motion-active window signal
(#15114), so `observe(waitFor: stable)` waits them out.

A stack's `transition` is the screen navigation animation only. The stack's own `visibleWhen`
uses the default visibility animation; wrap the stack in a box to give that a custom transition.

## Motion v2 (#14208, `prototype_motion_v2`)

- **Animated style.** A node's `animate: {tempo?}` selects a contract spring (see Motion tokens), or
  `animate: {durationMs?, easing?}` selects timing (0–2000 ms, default 300;
  `standard` (default), `emphasized`, `linear` or `spring`, which ignores the duration) makes
  changes to its `alpha`, `offset`, `scale`, `rotation`, `background` and `color` animate, for
  example a heart that grows and turns red when a `styleWhen` matches. Without `animate` those
  changes stay instant.
- **Scale and rotation.** Style `scale` (0–4) and `rotation` (-360..360 degrees) are drawn about
  the node's centre without changing its layout slot, like `offset`; `styleWhen` can set them.
- **Transitions.** `transition` also takes `slideStart` and `slideEnd`, which slide in from and out
  to that edge (a drawer), and `scale`, which scales in with a fade. Start and end follow the layout
  direction, so drawers mirror in right-to-left locales.
- **Zoomable images.** An `image` with `zoomable: {maxScale}` (1–8) pinches between 1 and
  `maxScale`, pans within its own bounds once zoomed, and toggles between 1x and 2x (or
  `maxScale`) on a double tap; TalkBack gets "Zoom in" and "Zoom out" actions. The zoom is clipped
  to the image's box and does not change its layout or reported bounds. `onTap` still runs; a
  zoomable image cannot also have `onDoubleTap` (rejected at `<path>.zoomable`).
- **Reduced motion.** Under `motion: "none"` or animator duration scale 0, style changes and
  transitions snap, so `observe` and screenshots stay deterministic. Zoom changes are always applied
  directly.

Android draws scale and rotation with a `graphicsLayer`, animates with `animateFloatAsState` and
`animateColorAsState`, and zooms with `transformable`. The iOS agent supports and advertises
`prototype_motion_v2`: `animate`, style `scale`/`rotation`, `slideStart`/`slideEnd`/`scale`
transitions, and `image.zoomable`. Motion v3 requirements are detected, but iOS does not advertise
`prototype_motion_v3`, so the host refuses motion v3 features until iOS advertises that capability.

## Transition choreography (#15247, `prototype_choreography_v1`)

- **Delayed enters.** `transition` also takes `{type, delayMs?}` (`delayMs` 0-600 ms) in place of
  the plain name; the enter starts after the delay and runs a 300 ms tween. A delay applies to
  enters only, so a hidden node still leaves at once.
- **`blurReplace`.** A blur and fade: the node enters from a 12 dp blur that clears as it fades in,
  and leaves the other way. `Modifier.blur` does nothing below Android 12, which leaves the plain
  fade there.
- **Stagger.** A `box`, `row` or `column` takes `stagger: {ms, order?}` (`ms` 0-100; `order`
  `forward` (default), `reverse` or `center`). Its direct children with `visibleWhen` enter one
  after another in layout order, each `ms` apart, including the children a `repeat` makes. A child's
  own `transition.delayMs` adds to its stagger wait.
- **Limit.** No child waits more than 600 ms in all. The validator counts the children and a
  literal `repeat` and rejects a longer wait at `<path>.stagger`; a data-bound `repeat` has no
  static count, so the renderer clamps the wait to 600 ms instead.
- **Reduced motion.** Under `motion: "none"` or animator duration scale 0 nothing animates, so no
  delay applies and `observe` sees the settled tree.
- **Retained subtrees.** A large `fade` or `none` subtree that the renderer keeps composed while
  hidden (a scroll list) still fades without the delay.

The render model carries each child's wait as `enterDelayMs` (stagger rank times `ms` plus its own
delay, at most 600), so the stagger is decided with the tree and not while it draws. The iOS agent
does not advertise the capability yet, so the host refuses these fields there.
