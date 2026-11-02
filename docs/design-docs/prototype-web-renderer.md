# Prototype web renderer

The web renderer draws a prototype inside a device frame as one self-contained HTML page. This
document covers the still renderer and the device frame registry.

## Still renderer

`renderPrototypeStill(spec, {frame, orientation, mode})` in `src/features/prototype/web/webStill.ts`
draws the spec as a still screen and returns an element tree plus `unsupportedNodes`. It renders on
the host, so the page's script only switches between views it was given and never runs spec logic.

- **Input.** The spec after component expansion, with its own `state` and `data`. The stack shows
  its `start` screen. No action, timer or `request` runs.
- **Text.** String-table translations resolve first, in the still's fixed `en-US` locale. Then
  `{data:/pointer}` placeholders bind (a missing or non-scalar value is empty),
  then repeat items, then a bare `{key}`, which reads spec state, and `{derived:name}`, which reads a
  top-level `derive` entry. Repeat placeholders
  bind each object item (a literal `items` array or a data pointer; scalar items are skipped
  before indices are assigned, as on devices), including the repeat's own `derive`
  fields. Text binds once, in that order, so a substituted value is never read again as a
  placeholder. Nested conditions with typed operands and state keys bind through the devices' own
  field walk (`mapBindableFields`). A spans-only text node renders each span
  with its own text style. A `secure` or `password` text field shows its value masked. Formatting uses `en-US`, `UTC` and a
  caller-supplied clock (default 0), so derived relative times are fixed.
- **Conditions.** `visibleWhen` evaluates `key` comparisons with `all`, `any` and `not` against
  spec state. Parts the still cannot decide (`data` and `platform` pointers, unknown keys, validity,
  string operators) stay undecided through `all`, `any` and `not`; only an undecided whole
  condition counts as true, so a node is never hidden on a guess.
- **Window.** An explicit `window.layoutDirection` sets the content's `dir` (the frame is never
  mirrored), and `start`/`end` safe-area edges read the inset on the matching physical side. Fullscreen fills the screen, and a fullscreen or sheet root fills its window on
  each axis it leaves unsized, as on devices; a sheet spans the screen width, `height` dp tall at its `edge`; a floating window
  sits at its `gravity`, moved by its `offset`.
- **Style precedence.** A control's default styling applies first and the spec's own style wins.
  `styleWhen` entries whose condition holds merge over `style` in authored order; an entry the
  still cannot decide is not applied. `textStyle` resolves to the Material 3 type scale before
  explicit `textSize`, `fontWeight` and `lineHeight`.
- **Layout.** Rows, columns, cards and scrolls (reversed when `reverse`, so they open at the end) are flex
  lines that start-align children on the cross axis unless
  `style.alignment` says otherwise, as both devices do; a box is a one-cell grid aligned by
  `style.alignment`, and stack screens fill the stack. `fill` (inside a box grid, only on its own axis), `{dp}`, `weight`, padding (logical
  start and end), corner radius, border, elevation and alpha map to CSS. 1 dp is 1 CSS px.
- **Typography.** `theme.typography` scales every type-scale role and sets its family, as the
  native theme does.
- **Colour.** Theme roles resolve with the same Material 3 baseline and overrides as the
  accessibility lint. A spec whose scheme derives from a seed or device source leaves unresolved
  roles unpainted. Unpainted screen regions show a checkerboard. An explicit `theme.mode` of
  `light` or `dark` wins over the caller's `mode`; `system` or no mode uses the caller's, then
  light.
- **Coverage.** Supported nodes: `box`, `row`, `column`, `stack`, `scroll`, `text`, `spacer`,
  `divider`, `icon`, `button`, `topAppBar`, `textField`, `switch`, `checkbox`, `card` and
  `listItem` (with its leading icon and its trailing switch, checkbox or icon). A text field draws
  its leading and trailing icons. A top app bar draws its navigation icon
  and actions as icon placeholders labelled with their action, and its `variant` sets its height,
  title size and title alignment. A button, switch, checkbox, text field or
  list item whose `enabledWhen` is decidably false draws disabled. A button draws its `icon` before
  its label, a divider paints its authored colour, text decorations and built-in font
  families map to CSS, and a span keeps its own background. A text field shows `errorText` with error colours when `errorWhen` is
  decidably true, and otherwise its `supportingText`; it draws filled chrome (the native default) or an outline for `outlined`; its label floats above
  a value or placeholder, and sits in an
  otherwise empty field; a multiline field keeps newlines and its `minLines`/`maxLines` (24 px
  lines); a captioned field's wrapper takes its size,
  weight and alignment in the parent. A spacer with no width, height or weight
  fills its line, and a line around one grows to its parent's size on its unsized axes, as a
  Compose parent does around a `fillMaxSize` child. Icons draw as a tinted square titled with the icon name, because the glyph set is not
  inlined. An `image` draws a placeholder with reason `assetNotInlined`. Any other node draws a
  dashed placeholder labelled with its type and id, with reason `unsupportedType`.
- **Frame.** The screen has the frame's size for the orientation, its corner radius and bezel, a
  generic status bar, the cutout and the navigation handle (or three generic button marks, which move to
  the right edge in landscape when the frame reserves that inset). Landscape swaps the screen size, uses
  the landscape safe areas, and moves the cutout from the top edge to the left edge. A frame whose
  landscape top inset is 0 (an iPhone) draws no status bar in landscape. `safeAreaPadding` adds the inset on each named edge to the node's padding; like
  `windowInsetsPadding`, an edge an ancestor already applied adds nothing more, and an inset adds to a component's own
  padding on that edge (`ime` adds nothing,
  since the still has no keyboard). Safe areas are exposed as
  `--safe-top`, `--safe-bottom`, `--safe-left` and `--safe-right`. A top app bar takes no inset
  of its own, as on the devices: it clears the status bar only through `safeAreaPadding`.
- **Determinism.** Serialization writes attributes and style properties in sorted order, so the
  same input renders the same bytes. Event-handler attributes are rejected.

## Device frame registry

`src/features/prototype/web/deviceFrames.json` is data only: adding a device is one entry, with
no code change. `deviceFrames.ts` validates it with a strict schema when the module loads, so an
invalid entry fails the first import and its unit test instead of rendering wrong geometry.

It is called a _frame_ registry, never a device profile, because `deviceProfile` already means
the session broker's OEM manufacturer profiles.

Each entry records:

- `screen`: portrait width and height in dp (points on iOS) and the density.
- `cornerRadiusDp`, the `cutout` (`none`, `punchHole`, `notch` or `island`, with its geometry),
  `statusBarDp` and the `navBar` (`none`, `gesture` or `buttons`).
- `safeArea` for portrait and landscape. Landscape is stored, not derived, because a cutout and
  the navigation bar move to different edges on each platform.
- `frame`: the bezel width and colour drawn around the screen.
- `source`: where the screen geometry and the insets came from. Values not yet measured on an
  emulator or simulator say so, and replacing them with measured values is a data change.

Beyond the schema, a registry is invalid when two entries share an id, a cutout lies outside the
portrait screen, or a safe area leaves no screen in either orientation.

When a request names no frame, the default is `pixel-9` for Android and `iphone-16` for iOS. An
unknown frame id is an error that lists the valid ids.
