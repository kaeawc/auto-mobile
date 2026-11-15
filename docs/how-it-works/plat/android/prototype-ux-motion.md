# Motion

Part of [the agent-authored prototype specification](prototype-ux.md).


Text nodes accept `contentTransition: "numeric" | "crossfade" | "none"` (default `none`). Non-`none` requires `prototype_content_transition_v1`. Numeric changes roll only changed characters up for an increase and down for a decrease; formatting is stripped to digits, the first decimal point and a leading minus. Missing or equal numeric values crossfade; identical text stays still. Spans crossfade as a whole. Roll uses a spring (Android damping 0.8, stiffness 380; iOS duration 0.35 s, bounce 0.15); fades take 200 ms. Accessibility and observe expose the new text immediately. Android reduced motion uses fades and motion off snaps; iOS content transitions snap under reduced motion or motion off.

`scrollTransition: {axis, edge: {scale?, alpha?, rotation?}}` on a descendant
of a scroll, pager, carousel or repeat interpolates from the authored edge values
to identity at the viewport center. Its `axis` is `horizontal` or `vertical`.
The `scrollLinked: {source, range: [start, end], alpha?, scale?, offsetY?, offsetX?, blur?}`
uses the offset in dp of a scroll with that `id` in the same stack screen. The
input endpoints increase; each output is a pair that may increase or decrease.
Values interpolate linearly and clamp outside the input range. At least one
output is required. Alpha is clamped to 0–1 and blur to a nonnegative radius. Android blur requires Android 12 or later.

Both fields require `prototype_scroll_motion_v1`; each counts as one binding,
with at most 16 bindings after component and repeat expansion. These are drawing
transforms: layout slots, hit targets and reported bounds stay fixed. The
`reduced` profile keeps alpha and drops scale, rotation, offsets and blur;
`none` retains all scroll-driven outputs because they follow position, not time.

Prototype state changes animate by default (#10442). A node with `visibleWhen`
fades and expands in and fades and shrinks out; a pager page change driven by
`setPage` animates the scroll instead of jumping. Spec-level `motion: "none"`
opts out and keeps every change instant. Motion is also off when the system
animator duration scale is 0 (`adb shell settings put global
animator_duration_scale 0`), so `observe` screenshots are settled with no
extra waits; other scales are honored by Compose's animation clock. The runtime
observes the scale while the prototype is shown. Setting it to 0 after the prototype is up
makes the next visibility or page change instant, and turning motion off
mid-scroll snaps the pager to its target page. Only nodes with `visibleWhen` get
an animation wrapper.

`box`, `row` and `column` containers animate their size when their children
appear, disappear or change (`animateContentSize`), gated by the same
motion-enabled check, so a sibling slides into the freed space instead of
jumping.

A non-stack node's optional `transition` picks the `visibleWhen` enter/exit: `none`
(instant), `fade`, `expand` (grow/shrink) or `slide` (vertical slide with a
fade). Absent keeps the default fade + expand. It has no effect on nodes
without `visibleWhen`, or when motion is off; a show reports the advisory
`transition-without-visible-when` accessibility finding for that case.

A style `pressScale` (0.5–1) shrinks a tappable node while it is pressed. With
motion on it animates with a short spring; with `motion: "none"` or animator
scale 0 it snaps, so a screenshot taken mid-press is still deterministic.

## Expressive and layout motion (`prototype_motion_v3`)

`motion: "expressive"` selects Material 3 expressive springs. Standard remains the default.

| Change                                                      | Expressive spring |
| ----------------------------------------------------------- | ----------------- |
| Visibility size, offset, scale; container size; press scale | Default spatial   |
| Visibility alpha; press alpha; animated color and alpha     | Default effects   |

Node `animate` also tweens `border.color`, `border.width`, `cornerRadius`, `elevation`,
`shadowColor`, `padding`, and dp `width`/`height`. Its duration and easing apply as before;
`easing: "spring"` uses the expressive spring when expressive motion is selected. Text, font,
gradient and fill/wrap/token swaps remain instant.

Node `press: {scale?, alpha?}` requires at least one field: scale 0.85–1, alpha 0.5–1.
It requires tap/long-press/double-tap actions or an inherently pressable control (button,
iconButton, fab, chip, listItem, switch, checkbox, radioGroup, segmentedButton, select or menu).
`press.scale` overrides `style.pressScale`. Feedback changes drawing only, keeping the 48dp
minimum touch target and reported bounds. Component gestures remain owned by their controls.

With `motion: "none"` or animator scale 0, style changes and control state visuals are instant,
and clickable nodes and Material controls draw no ripple. Material boolean controls are keyed
by their final state while off to avoid starting their internal animations; slider position is
immediate and its thumb uses a resting interaction source. Reduced motion still snaps spatial
changes and preserves fades and colors.

## Window and modal motion

Android `prototype_window_motion_v1` gates authored `window.transition` and
`repeat.stagger`. Window transitions are `auto` (default), `none`, `fade`, `slide`,
or `scale`. Auto slides a sheet from its placement edge, fades and scales a
floating surface from 0.92 to 1, and fades fullscreen content. Exit mirrors enter.
Same-id shows update the existing window when motion is off or the incoming
transition is `none`, preserving focus and keyboard attachment. With full or
reduced motion and an animated transition, replacement attaches a new window
while the outgoing window exits; focus transfers to the new window. Changes to
display, layer or surface id also require a new window regardless of motion.

Root Compose content animates for 300 ms; removal is scheduled through the host
settle timer at 400 ms, independent of animation frames. Exiting windows become
non-touchable immediately. Outgoing windows retain their hierarchy motion metadata
and shared image/font assets until detach; service teardown drains these exits
immediately. Dismissal events and sequence allocation retain their
existing timing at exit start. Agent shows animate; device-persistence boot
restoration does not. Idle TTL, last-client disconnect and service teardown remove
windows immediately to keep teardown bounded.

Bottom sheets slide from the bottom, dialogs and menus fade and scale, and
snackbars fade and slide. Scrims fade with their surfaces. Panels remain composed
through exit, including when removed from the authored tree; a patch reopening a
panel cancels its exit and re-enters. The `SheetDismiss` and modal button actions
commit at exit start, so runtime state and emitted action events change immediately.
Retained visual content finishes exiting afterward with input disabled and its
semantics cleared.

A dragged sheet follows the
pointer directly and springs to the selected detent on release. Reduced motion
uses fades without translation, scaling or detent springs. Off motion snaps and
keeps the settled rendering unchanged. Window and modal transitions and detent
settles participate in the motion-active signal, following the conventions of
#15114 (see Motion-active signal). The surface reports itself through
`ReportPrototypeMotion` while an exit or settle runs, so `observe` never captures it mid-flight.

`repeat.stagger` is an integer 0–100 ms per instance, in item order. Only template
children with `visibleWhen` receive it. It adds to container stagger and transition
delay through the existing enter-delay machinery, with each total capped at
600 ms; exits are not delayed.

iOS accepts the structural contract but does not advertise `prototype_window_motion_v1`, so host
preflight refuses either authored field.

## Attention loops (`prototype_loops_v1`)

(Android only, requires `prototype_loops_v1`) Any node accepts
`attentionLoop: {effect: "pulse" | "spin", periodMs: 400–4000, iterations?: 1–20 | "infinite"}`.
The period and finite count are integers; omitted iterations means infinite. Pulse scales
1 → 1.08 → 1 per period; spin turns 0 → 360 degrees. Drawing changes without changing
layout, reported bounds or touch targets. A pulse node must omit `style.scale`; a spin node
must omit `style.rotation`, including every `styleWhen` style. At most eight expanded nodes
may carry loops, including repeat instances; shimmer does not consume that limit.
Finite loops settle at identity and contribute to settling motion while running. Infinite
loops and shimmer contribute only to the intentional loop count. Reduced motion, motion
none and animator scale 0 leave loops at rest. On Android each observe metadata read renews
a 1500 ms capture hold. During it, attention loops draw identity and shimmer draws no band,
so captures within the hold are identical when the rest of the scene is unchanged.

The runtime renews its capture hold in the controller’s window-metadata read path, alongside
`prototypeMotion`. The hold uses an injected monotonic clock and a 1500 ms deadline; repeated
reads extend it. Compose reads the deadline during drawing and invalidates the loop layer on
renewal. Animation time continues through a hold, so a finite loop still completes on schedule.
The first expanded node beyond `MAX_PROTOTYPE_LOOPS = 8` fails at `<node path>.attentionLoop` with
`Loop node limit exceeded`. Conflicting rest transforms fail at the same path.

## One-shot keyframes

Every node may carry `keyframes: {trigger, durationMs, tracks}`, gated by
`prototype_keyframes_v1`. The trigger is exactly one declared state `{key: "liked"}`
or a data pointer `{data: "/liked"}` relative to the data object. A value change plays
once; mounting does not play, and a change during playback restarts from zero.

`durationMs` is an integer from 100 to 3000. Tracks contain one to seven of `scale`,
`scaleX`, `scaleY`, `rotation` (degrees), `offsetX`, `offsetY` (dp), and `alpha`.
Each is 2–8 `[fraction, value]` points or `{points, curve?}`; fractions increase strictly
from 0 to 1. Curves are `linear`, `standard` (default, cubic Bezier 0.2,0,0,1), and
`spring`. Scale values are positive and alpha stays in 0–1. Both ends equal rest:
1 for scale and alpha, 0 for rotation and offsets. The first node beyond the expanded
16-node budget fails at its `.keyframes`, including component and repeat instances.

One Compose `Animatable` drives draw-time layers, composing scale/alpha multiplicatively
and rotation/offsets additively with style motion. Tracks do not change layout or authored
semantics. Reduced motion drops spatial tracks and retains alpha; off disables playback.
Finite playback contributes to the motion-active signal. The pure spring sampler uses a
normalized damped ease derived from damping ratio 0.8 and stiffness 380, with exact endpoints.
On iOS, the runtime runs one linear `KeyframeAnimator` phase per track and applies the same sampler as Android, so all three curves match across platforms. A `trigger.key` is a plain declared state key, not a per-row bound key, so every repeat instance plays on the same trigger. Per-row triggers need a bound-key form and are not part of v1.

## Motion profiles (#15115, `prototype_reduced_motion_v1`)

Motion runs in one of three profiles, decided identically on both platforms from the spec's
`motion` and the system setting:

| Profile   | Chosen when                                                                                                            | Behaviour                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`    | Neither of the rows below applies.                                                                                     | Every animation described in this section.                                                                                                                                                                                                    |
| `reduced` | `motion: "reduced"`, or on iOS system Reduce Motion.                                                                   | Spatial animations (slide, expand and shrink, scale, container size, `pressScale`, swipe-row and stack slides, shared element morphs) become crossfades or snap. Loops (shimmer, indeterminate progress) rest. Color and alpha still animate. |
| `off`     | `motion: "none"`, or on Android animator duration scale 0 or transition animation scale 0 (read from Settings.Global). | Everything is instant.                                                                                                                                                                                                                        |

`none` wins over `reduced`, and a system `off` wins over both. Android has no system reduced
setting, so there `reduced` comes from the spec alone; both scales are observed while the prototype
is shown. On iOS the system Reduce Motion setting (and `UIAccessibility.prefersCrossFadeTransitions`)
selects `reduced` rather than `off`, so a Reduce Motion run shows crossfades; `motion: "none"` is still fully instant. `motion: "reduced"` needs
`prototype_reduced_motion_v1`, which the host checks before showing.

## Shared element morphs (#15115, `prototype_shared_element_v1`)

`sharedKey` names two `visibleWhen` nodes as one element, so swapping them morphs the first into
the second (a list row into a detail card, a thumbnail into a viewer):

```json
{
  "state": { "open": false },
  "root": {
    "type": "box",
    "children": [
      {
        "type": "row",
        "sharedKey": "album",
        "visibleWhen": { "key": "open", "equals": false },
        "onTap": [{ "type": "setState", "key": "open", "value": true }],
        "children": [{ "type": "text", "text": "Album" }]
      },
      {
        "type": "card",
        "sharedKey": "album",
        "visibleWhen": { "key": "open", "equals": true },
        "onTap": [{ "type": "setState", "key": "open", "value": false }],
        "children": [{ "type": "text", "text": "Album" }]
      }
    ]
  }
}
```

A literal key referenced as a zoom source labels exactly one node and is exempt from the
`visibleWhen` requirement and visibility-pair counting.

Rules, enforced by every validator with exact paths: `sharedKey` retains the state-key grammar
and aliases `shared: {key, as: "bounds"}`. The object form requires
`prototype_shared_element_v2`; plain `sharedKey` requires `prototype_shared_element_v1`.
A node cannot set both. Visibility morph nodes must have `visibleWhen`. Literal v2 keys allow hyphens in addition
to the state-key characters, with a 64-character resolved limit. Literal visibility morph keys pair exactly two
nodes. Inside repeat children, a key template must reference the field named by `repeat.key`,
without index or other-field placeholders. Each instance must resolve a distinct key; at most
two nodes can use each resolved key. Unmatched repeat items remain ordinary cards. A spec has
at most 16 resolved keys for visibility morphs, including unmatched feed items. Pairs cannot nest, disagree on `as`, or cross a `dialog` or `bottomSheet`
boundary (including two separate modals). Shared elements across pager pages and `stack` screens
are not supported.

Under `full`, Android applies `sharedElement` for `as: "element"` (identical content, only the target
draws) and `sharedBounds` for `as: "bounds"` (changing content, both sides crossfade), in one
`SharedTransitionLayout`. On iOS the runtime uses `matchedGeometryEffect(properties: .frame)` in one
namespace; bounds also crossfades the two sides. The morph counts in the motion-active signal. Under
`reduced` both kinds crossfade in place; under `off` they swap instantly. A pair visible at the
same time keeps ordinary visibility behavior. Shape interpolation still needs `animate` on
`cornerRadius`; image content scale snaps.

A feed card expanding into a detail column uses the same spec on Android and iOS. Here the one
feed item binds `story-{item.id}` to `story-one`; tapping it swaps the pair. More feed items may
have unmatched keys until their corresponding detail is shown.

```json
{
  "window": { "placement": { "type": "fullscreen" } },
  "state": { "open": false },
  "root": {
    "type": "box",
    "children": [
      {
        "type": "column",
        "repeat": { "items": [{ "id": "one" }], "as": "item", "key": "id" },
        "children": [
          {
            "type": "card",
            "shared": { "key": "story-{item.id}", "as": "bounds" },
            "visibleWhen": { "key": "open", "equals": false },
            "onTap": [{ "type": "setState", "key": "open", "value": true }],
            "style": { "width": { "dp": 160 }, "height": { "dp": 80 } },
            "children": [{ "type": "text", "text": "Story {item.id}" }]
          }
        ]
      },
      {
        "type": "column",
        "shared": { "key": "story-one", "as": "bounds" },
        "visibleWhen": { "key": "open", "equals": true },
        "onTap": [{ "type": "setState", "key": "open", "value": false }],
        "style": { "width": { "dp": 320 }, "height": { "dp": 400 } },
        "children": [{ "type": "text", "text": "Story one: the full detail" }]
      }
    ]
  }
}
```

## Motion-active signal (#15114)

Fades and scales change no node, so two identical hierarchy reads do not prove a
prototype has stopped moving. The prototype window's entry in a hierarchy capture
carries `prototypeMotion: {active, loops}` next to `prototypePlacement`
(`prototype_window_metadata_v1`; older APKs omit it and hosts read absence as
settled). The `active` field counts the animations that will finish: `visibleWhen` and
retained-visibility transitions, `animate` style animations, `pressScale`,
container size changes, swipe-row settles and pager scrolls. The `loops` field counts
intentional infinite animations (today only the shimmer) and hosts ignore it.
Both `observe(waitFor: stable)` and the launcher/SystemUI quiet-tree wait do not settle
while `active` is positive and stay bounded by their usual timeout. The count is
zero after a single frame under `motion: "none"` or animator scale 0.
