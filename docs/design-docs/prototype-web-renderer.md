# Prototype web renderer

The web renderer draws a prototype inside a device frame as one self-contained HTML page. This
document covers the resource that serves it, spec revisions, the page, the still renderer and the
device frame registry.

## Resource

`automobile:prototype/{id}/web{?frame,revision,variant}` (`text/html`) is registered in
`src/server/prototypeResources.ts` and read by `readPrototypeWebResource` in
`src/features/prototype/web/prototypeWebResource.ts`.

- **Variants.** The page's variants are the ids whose latest revision carries the same
  `variant.group` as `{id}`'s, in first-seen order, labelled by `variant.label`; an id without a
  group is the only variant, labelled by its id. `variant` (default `{id}`) picks the one shown
  first and must be in that set.
- **Revision and frame.** `revision` (default the latest) is a kept revision of the variant shown
  first. `frame` defaults to `defaultDeviceFrameId` of the platform that showed that revision, else
  `pixel-9`.
- **Errors.** An unknown id lists the known ids; an evicted revision names the oldest kept; an
  unknown revision lists the kept ones; an unknown frame or variant lists the valid ones. All are
  `ActionableError`s.
- **Read result.** `_meta` is `{revision, deviceRevision?, revisions, variants, frame, sha256,
  rendererVersion}`; `rendererVersion` is the server release version.
- **Listing.** Each known id gets a concrete resource `automobile:prototype/{id}/web` named
  `prototype-{id}-web`, titled `{id} (web)`, registered when its first revision appears and
  unregistered when the id is evicted; each change sends `list_changed`. List entries carry no
  `size`, `annotations` or `_meta`, because the registry's entries do not; the read result carries
  `_meta`.
- **Updates.** Every new revision sends `resources/updated` for the parameter-free URI of the id and
  of each id in its variant group, in revision order. The concrete resource matches subscriptions
  exactly, so a subscription with any query (`?revision=N`, `?frame=…`) is never notified.

## Spec revisions

`PrototypeSpecRevisions` (`src/features/prototype/prototypeSpecRevisions.ts`) is fed by
`PrototypeShownSpecs`, so a revision exists exactly when the shown-spec mirror accepts a spec:

- `endShow` storing a spec records a `show`; refused, superseded and poisoned shows, and shows the
  mirror leaves untracked (persisted `/data`), record nothing. `commitPatch` committing records a
  `patch` with the reply's `revision` as `deviceRevision`. Device data writes record nothing.
- Numbers start at 1 per id and never repeat, even after the id is evicted. Each revision keeps a
  copy of the spec, the platform of the device, the host clock time and the variant. A show states
  its `variant` afresh (none leaves the group); a patch keeps the id's last one. `variant` is
  host-only and never sent to the device.
- Bounds: the last `MAX_PROTOTYPE_SPEC_REVISIONS` (20) per id, and `MAX_PROTOTYPE_SPEC_REVISION_BYTES`
  (32 MiB) of spec JSON across ids. Over the byte cap the oldest non-latest revision goes first;
  when only latest revisions remain, the least recently revised other id is dropped whole.
- The daemon keeps one store for the process (`daemonPrototypeSpecRevisions`), outliving any one
  prototype host; a host with injected state gets its own. Nothing is persisted across restarts.

## Page

`buildPrototypeWebPage(input)` in `src/features/prototype/web/webPage.ts` returns one HTML
document, its `sha256`, the frame used, the unsupported nodes of the first view and the revisions
it inlined per variant.

- **Views.** Every inlined revision of every variant is pre-rendered in portrait and landscape.
  The first view is the chosen variant's chosen revision (default: latest) in portrait; the rest
  are `hidden`.
- **Controls.** Only four: rotate (portrait/landscape), zoom and pan (fit, 50–400 %, wheel, drag,
  double-click to fit), a variant select (only with more than one variant) and the revision
  history (newest first, `r<N> · show|patch`). Controls are buttons and a select with labels.
- **Script.** `prototypeWebPageRuntime` is inlined from its `toString()`, so it must stay
  self-contained. It only shows and hides views and moves the stage; UI state stays in memory, with
  no storage, cookies or URL changes. It must stay at or below 150 KB.
- **No network.** The CSP is `default-src 'none'`, the script pinned by its SHA-256, inline
  styles, and `data:` images and fonts. The page references no external URL.
- **Budget.** The page is at most 2 MiB. Each variant's latest revision is always kept; older
  revisions are added newest first while they fit, after measuring the shell (head, toolbar, full
  history list and script). If the latest revisions alone do not fit, the build fails with an
  `ActionableError` naming the largest view.
- **Determinism.** The same input yields byte-identical HTML.

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
  fields. Text binds once, in that order: every inserted data or repeat value is shielded until binding
  ends, so it is never read again as a placeholder. Nested conditions with typed operands and state keys bind through the devices' own
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
  start and end), corner radius (per-corner radii are logical, so RTL mirrors them), border, elevation and alpha map to CSS. 1 dp is 1 CSS px.
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
