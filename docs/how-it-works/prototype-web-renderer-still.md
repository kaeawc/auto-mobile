# Prototype web renderer: still renderer

Part of [the prototype web renderer](prototype-web-renderer.md).

`renderPrototypeStill(spec, {frame, orientation, posture, mode, screen, locale, textSize, chromeless})` in
`src/features/prototype/web/webStill.ts` draws the spec as a still screen and returns an element
tree plus `unsupportedNodes` and `stack` (the outermost stack's screens in key order, its
start and the screen drawn). It renders on
the host, so the page's script only switches between views it was given and never runs spec logic.

- **Input.** The spec after component expansion, with its own `state` and `data`. A stack shows its
  `start` screen; the outermost stack (the first one drawn) shows `screen` instead when it has that
  screen. No action, timer or `request` runs.
- **Text.** String-table translations resolve first, in the caller's `locale` (BCP 47, canonicalized;
  default `en-US`). An invalid tag is a `PrototypeWebInputError`, surfaced to clients as an
  `ActionableError` with the same message. Then `{data:/pointer}` placeholders bind (a missing or
  non-scalar value is empty), then repeat items. Last come a bare `{key}`, which reads spec state,
  and `{derived:name}`, which reads a top-level `derive` entry. Text binds once, in that order: the
  renderer shields every inserted data or repeat value until binding ends, so it never reads one
  again as a placeholder. Nested conditions with typed operands and state keys bind through the
  devices' own field walk (`mapBindableFields`). A spans-only text node renders each span with its
  own text style. A `secure` or `password` text field shows its value masked. Formatting uses the
  locale, `UTC` and a caller-supplied clock (default 0), so derived relative times are fixed.
- **Repeats.** Repeat placeholders bind each object item (a literal `items` array or a data
  pointer), including the repeat's own `derive` fields. As on devices, the renderer skips scalar
  items before assigning indices. A repeat draws at most 200 items, except a `list`, which draws up
  to the list contract limit (2,000) capped by its `maxItems`, as devices do. A 2,000-row list of
  plain list items is about 0.7 MB of markup, inside the page budget. A page whose kept start
  screens exceed it fails the build as described under **Budget**.
- **Platform state.** The frame decides `/device/os`, `/device/widthClass` and `/device/posture`
  from the active panel in the drawn orientation. On Android `widthClass` is `compact`, `medium` or
  `expanded` at the contract's 600 and 840 dp breakpoints. On iOS it is `regular` on a
  tablet (smallest side 600 dp or more) or a phone at least 896 dp wide, else `compact`. On
  Android an `opened` fold is `flat` and a `half_opened` one `tabletop` (horizontal hinge) or
  `book` (vertical hinge); without a fold, and always on iOS, posture is missing. Other
  `/platform` pointers stay undecided. The `{platform:/pointer}` text binds with the data pass: a
  decided value inserts (missing is empty) and an undecided placeholder stays literal.
- **Conditions.** `visibleWhen` evaluates `key` comparisons and decided `platform` pointers with
  `all`, `any` and `not` against spec and platform state. Parts the still cannot decide (`data`
  pointers, undecided `platform` pointers, unknown keys, validity, string operators) stay undecided
  through `all`, `any` and `not`. Only an undecided whole condition counts as true, so the still
  never hides a node on a guess.
- **Window.** An explicit `window.layoutDirection` sets the content's `dir` (the frame is never
  mirrored). Without one, a locale whose language or script is written right to left (Arabic,
  including `ar-XB`, Hebrew, Persian, Urdu and the like) sets `rtl`, as a device in that locale
  does. Any other locale leaves the page's direction. In either case `start`/`end` safe-area edges
  read the inset on the matching physical side. Fullscreen fills the screen, and a fullscreen or
  sheet root fills its window on each axis it leaves unsized, as on devices. A sheet spans the
  screen width, `height` dp tall at its `edge`. A floating window sits at its `gravity`, moved by
  its `offset`.
- **Style precedence.** A control's default styling applies first and the spec's own style wins.
  The `styleWhen` entries whose condition holds merge over `style` in authored order. The still
  does not apply an entry it cannot decide. The `textStyle` value resolves to the Material 3 type scale before
  explicit `textSize`, `fontWeight` and `lineHeight`.
- **Layout.** Rows, columns, cards and scrolls (reversed when `reverse`, so they open at the end)
  are flex lines. They start-align children on the cross axis unless `style.alignment` says
  otherwise, as both devices do. A box is a one-cell grid aligned by `style.alignment`, and stack
  screens fill the stack. These map to CSS: `fill` (inside a box grid, only on its own axis),
  `{dp}`, `weight`, padding (logical start and end), corner radius, border, elevation and alpha.
  Per-corner radii are logical, so RTL mirrors them. Each dp is 1 CSS px.
- **Style polish.** A `gradient` paints over the background across the whole node. A linear angle
  is clockwise from left-to-right (CSS's angle plus 90), and a radial one is centred and reaches
  the corners. Stop positions apply only when every stop has one, made non-decreasing. The
  `shadows` entries map to `box-shadow` with the authored blur as the CSS blur (sigma b/2), and
  `elevation` takes its `shadowColor` tint. A gradient border and inner shadows are absolutely
  placed layers after the node's children. They paint over the content, inside its bounds, as
  Compose draws them.
- **Glass.** A `surface: "glass"` node is a capsule unless `cornerRadius` shapes it. The iOS skin
  blurs and saturates the backdrop under a translucent tint (else white) with a light rim. The
  Android skin draws the tonal fill (the tint, else `surfaceContainer`, at 0.85); an authored
  background keeps its colour. The `ios.glassGroup` node draws nothing of its own.
- **Scroll fades.** The `scroll.fadeEdges` style is a mask on the trailing edge only (the leading
  one in a `reverse` scroll), since a still opens at the scroll's start. Horizontal start and end
  mirror in RTL. The still cannot measure overflow, so it hands the mask to the page as
  `--fade-mask`. A scroll-driven animation on a `scroll(self)` timeline applies it. That timeline
  is inactive while the content fits, so only an overflowing scroll fades, as Android draws a fade
  only while it can scroll forward. It depends on layout, not time, so screenshots stay
  deterministic. A browser without scroll-driven animations always fades.
- **Links and fallbacks.** The `linkify` style splits the resolved text into plain runs and one
  `data-link` span per match in its `style`. The still marks a span with `onTap` the same way;
  links get no style of their own, as on Android. A `zoomable` image draws at 1x. A node with
  `style.shader` draws without it, as a device without shader support does, and the still lists it
  with reason `shaderFallback`.
- **Typography.** `theme.typography` scales every type-scale role and sets its family, as the
  native theme does.
- **System text size.** `textSize` is the device's text setting, refused on the other platform's
  frame. On Android, `fontScale` (0.85 to 2) maps every sp value (size, line height, letter
  spacing) through Android 14's non-linear `FontScaleConverterFactory` tables, interpolating
  between neighbouring tables and linear below 1.03, as Compose does. On iOS, `contentSize` (the
  `simctl ui content_size` names, `extra-small` to `accessibility-extra-extra-extra-large`) scales
  every size and line height by the body style's point size over 17, as
  `UIFontMetrics.default.scaledValue` does, and leaves letter spacing. It applies after
  `theme.typography`, to text roles, explicit sizes, the 14 sp default and the fixed text of
  controls (app bar title, field label, caption and lines, list item text). Icons and the device
  chrome do not scale. The default size (`1`, `large`) renders the same bytes as none.
- **Colour.** Theme roles resolve from the Material 3 baseline, then the roles a `theme.colors.seed`
  derives, then the explicit overrides. The seed roles are the HSL approximation both devices
  share (`prototypeSeedScheme.ts`, Android's `prototypeSeedColorScheme`, the iOS agent's
  `seedScheme`), rounded to 8-bit channels as Compose stores them. A `device` source has no
  device scheme to read, so it falls through to the seed or the baseline, as iOS and Android
  below API 31 do. The accessibility lint still treats a seed or device scheme as unknown. Both
  devices paint nothing behind a window, so the app below shows through; the still has no app
  below, so the screen paints the theme's `background` role (else `surface`).
- **Mode.** The still resolves light or dark in the devices' order. An explicit `theme.mode` comes
  first. With no mode, the luminance of the flat `theme.colors.background` (else `surface`)
  override decides, then that of the first opaque hex background on the root's leading chain. The
  leading chain follows the first child that draws in place, so a hidden node or a closed sheet is
  passed over: a pager's current page, a scroll's `child`, a stack's drawn screen. The chain skips
  role and `{light, dark}` backgrounds. Last come the caller's `mode`, then light. A
  `theme.mode: "system"` value goes straight to the caller's. As on Android, an authored colour of
  the resolved mode's polarity replaces `background`, `surface` and
  `surfaceContainer`/`Low`/`High`/`Highest` unless a seed or device source derives the scheme.
  Role overrides still win over it.
