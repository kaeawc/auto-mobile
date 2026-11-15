# Prototype spec: style and icon effects

Part of [the agent-authored prototype specification](prototype-ux.md).

## Style

`prototype_style_polish_v2` gates layered `style.shadows`, `style.cornerStyle`,
`style.border.gradient`, `scroll.fadeEdges` and `image.filter`. A renderer must advertise
this capability before a host sends these fields.

- `shadows` is 1–3 strict `{color, radius, spread?, offset?, inner?}` entries. Radius is
  0–1000 dp, spread and each offset axis are -1000–1000 dp. Omitted spread is 0,
  omitted offset is `{x:0,y:0}`, and omitted inner is false. Layers paint in array
  order within the outer and inner groups: first is bottom-most, later layers sit on top.
  Blur radius `b` uses Gaussian sigma `b/2` (CSS-like blur). Android adapts this to
  the platform blur filter, whose minimum nonzero sigma is approximately 0.5 px.
  `color` takes the same hex, role or `{light,dark}` forms as `shadowColor`. `shadows` excludes both
  `elevation` and `shadowColor`, including explicit zero elevation.
- `cornerStyle` is `circular` (default) or `continuous`, including with `cornerRadius: "full"`.
  Continuous corners use dependency-free cubic smoothing (approximately 0.6), tapering
  to circular at half the short side so full radii remain valid pills/circles.
- A border is strict `{width, color?, gradient?}`, with exactly one of `color` or
  `gradient`. Gradient reuses the linear/radial background-gradient contract.
- A scroll node's `fadeEdges` is strict `{top?, bottom?, start?, end?}`, with at least
  one edge, each 0–1000 dp. Fades draw only on edges that can still scroll; start/end
  mirror in RTL. Top/bottom apply only to vertical scrolling, start/end only to horizontal
  scrolling. Each fade is capped to its viewport dimension.
- An image node's `filter` is strict `{saturation?, tint?}`, with at least one field.
  Saturation is 0–2 and tint is a colour value. Saturation applies first, then tint
  multiplies the image channels (including alpha). Other node types cannot set filter.

Pairs in shadows and image tint, and pairs or role names in border gradient stops,
also require `prototype_theme_modes_v1`.

Rendering order: transform, press scale, size, alpha, drop shadows (`shadows`/`elevation`
draw before the clip), clip (`cornerRadius` + `cornerStyle`), background, gradient,
shimmer, border (color or gradient), inner shadows.

All properties are optional. Sizes, padding, offsets, radii, and spacing use dp.
Numeric lengths are capped at 10000, including fixed dimensions, bounds x/y/width/height,
size constraints, padding, corner radii, border width, spacing, sheet height and fixed detents.
Offsets and bounds x/y range from -10000 to 10000. Elevation is capped at 1000; text size and line height
are positive and capped at 1000, and letter spacing ranges from -1000 to 1000.
Weight and aspect ratio range from 0.000001 to 10000. All endpoints are inclusive.

Text size uses sp, so it follows the system font scale. Negative offsets/positions
are allowed; sizes are nonnegative, except text size and sheet height/detent
height which must be positive. Positive values use a minimum of 0.000001.

| Property                                         | Accepted value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `width`, `height`                                | `"fill"`, `"wrap"`, or strict `{dp: n}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `weight`                                         | Positive number. A `row`/`column` child fills the remaining main-axis space in proportion to its weight (ignored elsewhere).                                                                                                                                                                                                                                                                                                                                                                                       |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | Nonnegative dp bounds applied after `width`/`height`, so `fill` and `{dp}` are clamped by them.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `padding`                                        | Strict `{top?, bottom?, start?, end?}`, each nonnegative dp; omitted edges are zero.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `background`, `color`                            | Strict hex color, or a Material 3 color role name (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cornerRadius`                                   | Nonnegative dp, a Shapes token (`none`, `extraSmall`, `small`, `medium`, `large`, `extraLarge`, `full`), or strict per-corner `{topStart?, topEnd?, bottomEnd?, bottomStart?}` of nonnegative dp where an omitted corner is square. Start and end follow the layout direction.                                                                                                                                                                                                                                     |
| `border`                                         | `{width, color?, gradient?}`; nonnegative dp width; exactly one paint source, a colour value or a linear/radial gradient.                                                                                                                                                                                                                                                                                                                                                                                          |
| `elevation`                                      | Nonnegative dp. Draws a shadow in the node's corner shape, behind its clip, background and border.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `shadowColor`                                    | Hex color or color role name tinting the `elevation` shadow (ambient and spot). Without `elevation` it draws nothing; absent, the platform shadow color applies.                                                                                                                                                                                                                                                                                                                                                   |
| `gradient`                                       | `{type: "linear", angle, stops}` or `{type: "radial", stops}`. `angle` is a finite number of degrees clockwise from left-to-right (0 = left to right, 90 = top to bottom). `stops` is 2–4 `{color, position?}` with a hex color and an optional 0–1 `position`; positions apply only when every stop has one (a position below the previous stop's is raised to it), otherwise stops are evenly spaced. Radial gradients are centered and reach the corners. Painted over `background` in the node's corner shape. |
| `aspectRatio`                                    | Positive number (width / height) applied after the size bounds.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `offset`                                         | Strict `{x, y}` dp, negative allowed. Shifts the drawn node, its shadow, touch target and accessibility bounds without moving siblings: the node keeps its layout slot.                                                                                                                                                                                                                                                                                                                                            |
| `alpha`                                          | Finite number 0–1; default 1. Multiplies window opacity.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pressScale`                                     | Finite number 0.5–1. A node with a plain `onTap` (box, row, column, text, image, icon, spacer) scales to this while pressed and back on release; absent leaves it unscaled. Instant, not animated, when `motion` is `none` or the system animator duration scale is 0; iOS also snaps under Reduce Motion. Component nodes (button, chip, switch, ...) keep their own press feedback and ignore it.                                                                                                                |
| `alignment`                                      | `topStart`, `topCenter`, `topEnd`, `centerStart`, `center`, `centerEnd`, `bottomStart`, `bottomCenter`, `bottomEnd`.                                                                                                                                                                                                                                                                                                                                                                                               |
| `arrangement`                                    | `start`, `center`, `end`, `spaceBetween`, `spaceAround`, `spaceEvenly`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `spacing`                                        | Nonnegative dp between row/column children; arrangement remains authoritative for distributed free space.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `textSize`                                       | Positive sp; scaled by the system font scale.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fontWeight`                                     | Integer 100–900.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `textAlign`                                      | `start`, `center`, `end`, `justify`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `maxLines`                                       | Integer 1–2147483647.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `overflow`                                       | Text past `maxLines` or its width: `clip` (default), `ellipsis` or `visible`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lineHeight`                                     | Positive sp between baselines; scaled by the system font scale.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `letterSpacing`                                  | Finite sp added between letters; negative tightens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `textDecoration`                                 | `none`, `underline`, `lineThrough` or `underlineLineThrough`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fontStyle`                                      | `normal` or `italic`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fontFamily`                                     | A system name (`default`, `sansSerif`, `serif`, `monospace`) or `{asset: "<id>"}` naming an uploaded TTF/OTF font (#10443).                                                                                                                                                                                                                                                                                                                                                                                        |

The text properties (`textSize`, `fontWeight`, `textAlign`, `maxLines`,
`overflow`, `lineHeight`, `letterSpacing`, `textDecoration`, `fontStyle`,
`fontFamily`, `textStyle`) style `text` nodes. An unset `fontStyle`,
`textDecoration`, `lineHeight` or `letterSpacing` keeps what the `textStyle` role
or the theme supplies.

Colors accept `#RRGGBB` or `#AARRGGBB`, with case-insensitive hex digits, or one
of the Material 3 `ColorScheme` role names (`primary`, `onPrimary`,
`primaryContainer`, `secondary`, `tertiary`, `background`, `surface`, `onSurface`,
`surfaceVariant`, `surfaceContainer` and its `Low`/`High`/`Highest`/`Lowest`
steps, `surfaceBright`, `surfaceDim`, `error`, `outline`, `scrim`, and the rest
of the scheme, 36 in all). A role resolves against the prototype's active theme
(`theme.mode`, `colors.seed`, device colour, `colors.<role>` overrides), so it follows light/dark and the
seed. No short hex, other named colors, CSS functions, or separate color opacity. Style
properties that do not apply to a node have no rendering effect; their shape is
still validated. Omitted layout/text properties use Compose/system defaults.
Start/end use layout direction, including RTL.

### Pager options

Any explicit `axis`, `pageSpacing`, `peek` or `pageSize` requires
`prototype_pager_options_v1`; an older device is refused before anything is shown,
even for explicit default values. Omission keeps existing behaviour.

- `axis`: `"horizontal"` (default) or `"vertical"`.
- `pageSpacing`: finite dp gap, 0..10000 (default 0).
- `peek`: strict `{start?: number, end?: number}`, each finite dp in 0..10000,
  exposing neighbouring pages along the main axis. Missing sides default to 0;
  `{}` is accepted as a no-op.
- `pageSize`: `"fill"` (default) or strict `{dp: number}`, finite 1e-6..10000,
  allowing several pages per viewport. The shared limit is `MAX_PROTOTYPE_PAGER_DP`.

A vertical pager cannot have any vertical scroll ancestor (omitted scroll axis is
vertical), even through intervening containers or horizontal scrolls. A vertical
pager inside only a horizontal scroll is valid; horizontal pagers stay valid.
The error is at the pager's `.axis`: "A vertical pager cannot appear inside a vertical scroll".

The horizontal counterpart (#14165): a horizontal (or default-axis) pager or a carousel cannot have
any horizontal scroll ancestor, because a horizontal scroll measures its child with an infinite
width that their lazy layouts cannot take. The errors are at the pager or carousel itself: "A
horizontal pager cannot appear inside a horizontal scroll" and "A carousel cannot appear inside a
horizontal scroll".

Current page means the first fully visible page: fixed sizes snap at Start; fill
uses the usual settled page. `page_changed`, `{page}` / `{pageCount}`, `setPage` and
navigation pager bindings keep their meaning. Stable keys and neighbour retention
stay unchanged. Every visible page (including partly visible peek and fixed-size pages) is exposed to accessibility, observe and `tapOn`; Android marks the current page selected only for pagers with positive peek or a fixed pageSize; iOS marks it selected on the options path (a pager with any non-default option) and not on the legacy paged pager; plain pagers expose only the current page on both. Pages fully off-screen are not exposed. Dot indicators are the pager `indicator` field (see Carousel and pager indicator). On iOS dp means points.

## Icon effects

An `icon` accepts `effect: {type, trigger?, repeat?}` under
`prototype_icon_effects_v1`. `trigger` is exactly `{key: "stateKey"}` or
`{data: "/pointer"}` and replays once when that value changes. Keys are literal
state keys. Omit both controls for one play on appearance. `repeat` is
`"infinite"` or an integer 1–20; trigger and repeat cannot coexist. `replace`
reacts to `name` changes. Scale holds at 1.15 while its trigger is truthy
(false, null, missing, zero and empty string are false).

| Type          | iOS native effect and minimum OS | Android approximation                  |
| ------------- | -------------------------------- | -------------------------------------- |
| bounce        | bounce, 17                       | scale 1 → 1.2 → 1                      |
| pulse         | pulse, 17                        | alpha 1 → 0.4 → 1                      |
| scale         | scale.up, 17                     | scale to 1.15 while trigger is truthy  |
| variableColor | variableColor, 17                | alpha sweep                            |
| wiggle        | wiggle, 18; bounce on 17         | rotation ±10°                          |
| rotate        | rotate, 18; no effect on 17      | rotation 0 → 360°                      |
| breathe       | breathe, 18; pulse on 17         | scale 1 → 1.06 with alpha              |
| replace       | symbol replace, 17               | crossfade with scale when name changes |
| drawOn        | drawOn, 26; replace on older OS  | crossfade                              |

Reduced and off profiles keep icons at rest, except reduced `replace` uses a
plain crossfade. Repeated effects count as loops in the motion signal and share
the eight animated-effect budget, including expanded repeat instances. During
Android capture, repeated effects rest so successive captures use the same pose.
Successful shows report Android approximations and iOS version fallbacks in
`platformNotes` at the icon's `.effect` path; when discovery has no OS version,
notes describe the conditional fallback explicitly.

The iOS `hide_for_capture` hold removes repeated symbol modifiers, returning icons to
rest until the last capture token releases or expires. Restoring restarts native
repeats. Local `PrototypeIconMotionActivity` tracks mounted repeated effects and
masks activity during capture; finite native repeats remain conservatively active
until unmounted because SF Symbols provides no completion callback. iOS has no
shared motion-active wire signal or shimmer reporter yet; this local signal is
not exposed to the host, and captures that bypass `hide_for_capture` do not rest effects.

Android uses a self-contained Compose animation with 600 ms cycles.
