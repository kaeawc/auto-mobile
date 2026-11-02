# Prototype web renderer

The web renderer draws a prototype inside a device frame as one self-contained HTML page. This
document covers the still renderer and the device frame registry.

## Still renderer

`renderPrototypeStill(spec, {frame, orientation, mode})` in `src/features/prototype/web/webStill.ts`
draws the spec as a still screen and returns an element tree plus `unsupportedNodes`. It renders on
the host, so the page's script only switches between views it was given and never runs spec logic.

- **Input.** The spec after component expansion, with its own `state` and `data`. The stack shows
  its `start` screen. No action, timer or `request` runs.
- **Text.** `{data:/pointer}` placeholders bind first (a missing or non-scalar value is empty),
  then repeat items, then a bare `{key}`, which reads spec state, and `{derived:name}`, which reads a
  top-level `derive` entry. Repeat placeholders
  bind each item (a literal `items` array or a data pointer), including the repeat's own `derive`
  fields, through the same binding contract the devices use (`bindNodeFields`): text and spans,
  nested conditions with typed operands, and state keys. A spans-only text node renders each span
  with its own text style. A `secure` or `password` text field shows its value masked. Formatting uses `en-US`, `UTC` and a
  caller-supplied clock (default 0), so derived relative times are fixed.
- **Conditions.** `visibleWhen` evaluates `key` comparisons with `all`, `any` and `not` against
  spec state. Parts the still cannot decide (`data` and `platform` pointers, unknown keys, validity,
  string operators) stay undecided through `all`, `any` and `not`; only an undecided whole
  condition counts as true, so a node is never hidden on a guess.
- **Window.** Fullscreen fills the screen, and a fullscreen or sheet root fills its window on
  each axis it leaves unsized, as on devices; a sheet is `height` dp at its `edge`; a floating window
  sits at its `gravity`, moved by its `offset`.
- **Style precedence.** A control's default styling applies first and the spec's own style wins.
  `styleWhen` entries whose condition holds merge over `style` in authored order; an entry the
  still cannot decide is not applied. `textStyle` resolves to the Material 3 type scale before
  explicit `textSize`, `fontWeight` and `lineHeight`.
- **Layout.** Rows and columns are flex lines that start-align children on the cross axis unless
  `style.alignment` says otherwise, as both devices do; a box is a one-cell grid aligned by
  `style.alignment`, and stack screens fill the stack. `fill`, `{dp}`, `weight`, padding (logical
  start and end), corner radius, border, elevation and alpha map to CSS. 1 dp is 1 CSS px.
- **Colour.** Theme roles resolve with the same Material 3 baseline and overrides as the
  accessibility lint. A spec whose scheme derives from a seed or device source leaves unresolved
  roles unpainted. Unpainted screen regions show a checkerboard. An explicit `theme.mode` of
  `light` or `dark` wins over the caller's `mode`; `system` or no mode uses the caller's, then
  light.
- **Coverage.** Supported nodes: `box`, `row`, `column`, `stack`, `scroll`, `text`, `spacer`,
  `divider`, `icon`, `button`, `topAppBar`, `textField`, `switch`, `checkbox`, `card` and
  `listItem` (with its trailing switch, checkbox or icon). A top app bar draws its navigation icon
  and actions as icon placeholders labelled with their action. A button whose `enabledWhen` is decidably
  false draws disabled. Icons draw as a tinted square titled with the icon name, because the glyph set is not
  inlined. An `image` draws a placeholder with reason `assetNotInlined`. Any other node draws a
  dashed placeholder labelled with its type and id, with reason `unsupportedType`.
- **Frame.** The screen has the frame's size for the orientation, its corner radius and bezel, a
  generic status bar, the cutout and the navigation handle. Landscape swaps the screen size, uses
  the landscape safe areas, and moves the cutout from the top edge to the left edge. A frame whose
  landscape top inset is 0 (an iPhone) draws no status bar in landscape. `safeAreaPadding` adds the inset on each named edge to the node's padding (`ime` adds nothing,
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
