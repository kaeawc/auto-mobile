# Prototype spec: windows and form factors

Part of [the agent-authored prototype specification](prototype-ux.md).

## Windows

`window` has required `placement` and optional integer `opacity` (0–100, default
100). Opacity fades authored content and scrims. Fullscreen windows (with either
chrome mode) and persistent non-fullscreen windows keep their host controls opaque.

| Placement `type` | Properties                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `fullscreen`     | Optional `scrim` color. Occupies the display and blocks app touches.                                                     |
| `sheet`          | Required `edge`: `top` or `bottom`; required positive `height` in dp. App stays touchable outside the window.            |
| `floating`       | Required `gravity` from the alignment list below; required `offset: {x, y}` in dp. Outside-window touches reach the app. |

Fullscreen and sheet roots default each omitted `width` or `height` to `fill`.
Fullscreen roots extend behind system bars and cutouts; sheet roots fill the
window's full width and specified height. Explicit dimensions and style constraints
still apply. Floating roots keep content sizing unless styled otherwise.
No display selection is defined here (#9308).

Optional `layer` (#10496) is `system` (default) or `app`.

- The `system` layer is
  `TYPE_ACCESSIBILITY_OVERLAY`, above system UI including SystemUI's screenshot
  flash and preview.
- The `app` layer is `TYPE_APPLICATION_OVERLAY`, just above apps. The
  shade, keyboard, toasts, system dialogs and the screenshot preview draw over the
  prototype. The status and navigation bars draw over a fullscreen one (safe-area
  padding matters more), and the keyboard covers its text fields like a real app's.

Non-default displays create their window context with the matching type. The `app` layer
needs SYSTEM_ALERT_WINDOW. The host grants it with
`adb shell appops set dev.jasonpearson.automobile.ctrlproxy SYSTEM_ALERT_WINDOW allow`
before the show. The device refuses the show with that command when the grant is
still missing. Android 12+ does not trust application overlays for touch pass-through,
so it can block gestures dispatched through an `app` prototype as
untrusted touches.

Optional `persistence` (#10494) is `session` (default) or `device`. See
Lifecycle and safety. Both fields are honoured only by a CtrlProxy that advertises
`prototype_window_options_v1`; the request decoder ignores unknown spec fields, so
the host refuses them for an older device instead of sending them.

Optional `chrome` (#12064) is `none` (default) or `bar`, fullscreen placement only,
on a device advertising `prototype_window_chrome_v1`. A spec with `persistence: "device"`
defaults to `bar`. The `none` value fills the window including under the status bar. Use
`safeAreaPadding` on the top edge of a `topAppBar` or top content. Relative sheet
detents use the full window height.

CtrlProxy intercepts a stationary two-finger
long press for 1 s before authored content and reveals a host dismiss pill for
5 s. Single-pointer taps and swipes cannot reveal it. The host wrapper also exposes
the `Dismiss AutoMobile prototype` accessibility dismiss action without touch.
While touch exploration (TalkBack) is enabled, the pill stays visible with no
gesture or timeout. Spec opacity fades only the content, keeping the pill opaque
even at opacity 0. A CtrlProxy without `prototype_window_chrome_v1` keeps the bar,
and the host refuses explicit `none`. Omitted chrome and `bar` succeed.
The field `lastResult.chrome` reports the effective chrome
on a successful fullscreen show and in subsequent host-local status, absent on
sheet/floating windows, dismiss, failed show and adopted prototypes.

### Frosted backdrop

Optional `window.backdrop` (#15126) is `{material, blur?, tint?}` and blurs what is behind the
window, on any placement and never the prototype's own content (that is the node-level `blur`
effect). Rules:

- `material` is required and closed: `ultraThin`, `thin`, `regular`, `thick` or `glass`. `glass`
  is Liquid Glass and exists on iOS 26+ only; every other platform draws the fallback for it.
- `blur` is an optional whole-number radius in dp (points on iOS) from 0 to 150. Absent uses the
  material's own radius. Larger values are refused, as are fractions and negatives.
- `tint` is optional and one colour: a hex or a Material role, never a `{light, dark}` pair, so the
  field needs no `prototype_theme_modes_v1`.
- Blur can be unavailable: Android below API 31, cross-window blur disabled by the device or
  battery saver, a window layer that cannot blur, or iOS below the material's minimum. There the device draws
  a tonal fill instead of nothing: `tint` at 85% alpha, else the `surfaceContainer` role at 85%. On Android this is the only
  path below API 31; from API 31 the blur is real (`RenderEffect`).
- The field needs `prototype_backdrop_v1`. A device without it would ignore the field and draw a
  plain window, so the host refuses the show (a placement `scrim` still dims what is behind).
  CtrlProxy and the iOS prototype agent advertise it (#15126). On iOS an authored `blur` picks the nearest
  material, and Reduce Transparency draws the tonal fill.
- Android: from API 31 the window asks for blur-behind when `WindowManager.isCrossWindowBlurEnabled`
  is true, with `tint` laid over it at 35% alpha. It uses `FLAG_BLUR_BEHIND`, radius = `blur` or the
  material's: ultraThin 8, thin 16, regular 24, thick 40 dp. Otherwise, and always for `glass`, it draws the
  tonal fill. Node-level `surface: "glass"` (#15244, #15256) reuses these pieces
  (`PrototypeBackdrops.plan`, `Modifier.prototypeRenderBlur`, the tonal fallback).
- A successful show reports `lastResult.backdrop`: `blur`, or `fallback` when the tonal fill was
  drawn. It is absent without `window.backdrop`, on dismiss, on a failed show and for adopted prototypes.

## Wear OS

Dismiss affordances are inset into the inscribed square of a round display so their corners
remain visible; non-round displays retain their existing placement. Authored fullscreen content
keeps its viewport.

On a watch, a successful `show` reports `screenRound` from the host's
`Configuration.isScreenRound`; the device omits it when the shape is unknown. TypeScript uses a
device-reported boolean directly and falls back to the ADB display reader only when it is absent.
Other form factors omit the tool's `screenRound` output.

On a watch whose launcher does not support pinned shortcuts, `save` with `pin:true` keeps the save
and reports `pinned:"unsupported"`. Round-aware layouts, `ScalingLazyColumn`, Wear Material
components and rotary input in prototypes are out of scope.

## Android Automotive

The renderer is phone-oriented, and on a car display it lays out wide and landscape. A successful `show` on
an Android device whose booted form factor is `automotive` reports `formFactor: "automotive"`. The value comes
from the device's form factor with no extra read, and other devices omit it. A `save` with `pin:true` uses the
same launcher check as everywhere else. So a car launcher without pinned-shortcut support keeps the save
and reports `pinned:"unsupported"` (the car launcher `com.android.car.carlauncher` has none).

The car
top bar can be taller than the `systemBars` top inset the overlay window receives. For fullscreen and
top-gravity floating windows, the host therefore uses the larger of that inset and the display's `systemBars` top
inset. The dismiss bar, the escape pill and top-edge `safeAreaPadding` clear the whole bar. With `none`,
authored content without top-edge `safeAreaPadding` still starts behind the car top bar. Car App Library templates and car-specific spec nodes are out of scope.

## Common node properties

Every node has required `type`. All other common properties are optional:

| Property             | Shape / meaning                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | Nonempty node ID; required and unique among pagers for `pager`. Other node IDs need not be unique.                                           |
| `testTag`            | Nonempty accessibility/test selector tag.                                                                                                    |
| `contentDescription` | Nonempty accessible label read by `observe` and screen readers in place of the derived one. `{key}` state placeholders resolve as in `text`. |
| `onTap`              | Nonempty ordered array of actions, run in order. See "Tap targets" below.                                                                    |
| `style`              | Strict style object below.                                                                                                                   |
| `styleWhen`          | Conditional style overrides (see Conditional style below). One to 8 entries.                                                                 |
| `visibleWhen`        | Condition (see Conditions below). A false condition, or a missing key, means hidden.                                                         |
| `transition`         | Except on stacks (see Stack transitions), optional `none`, `fade`, `expand` or `slide`: the `visibleWhen` enter/exit. See Motion.            |
| `sharedKey`          | Optional opaque key naming this `visibleWhen` node as the same element as one other node. See Shared element morphs.                         |
| `anchor`             | Bounds or app-element anchor below.                                                                                                          |
| `safeAreaPadding`    | Explicit inset selection below.                                                                                                              |

Hidden and closed sheet content still counts toward all limits and references.
No arbitrary extra metadata is allowed.

Accessible labels: an authored `contentDescription` wins. Otherwise a node takes its
label from its text, and an icon-only tappable node (or a tappable container
whose only content is one icon, such as a FAB) from its icon name. Layout
containers (`box`, `row`, `column`, `scroll`, `pager`, `spacer`, `card`) and
navigation bars are never labelled by their kind while they have content. A
layout container with no label, text, `onTap`, `testTag` or state adds no
accessibility node of its own, so its children join the nearest reporting
ancestor, as with Compose's own layouts.

Tap targets: a node with `onTap` responds across its whole drawn area, including
its own `padding`, and its accessibility bounds are that drawn area. It also
reserves a 48 dp minimum touch target, like Material components: a smaller node
keeps the size it draws at and is centered in the reserved space, which takes up
layout room.
