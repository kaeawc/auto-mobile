# Prototype web renderer

The web renderer draws a prototype inside a device frame as one self-contained HTML page. This
document covers the per-prototype resources (the page, the embed envelope and the single-file
Compose and SwiftUI sources), spec revisions, the page, its browser check, the still renderer and the device frame
registry.

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
- **Embed envelope.** `automobile:prototype/{id}/embed{?revision,variant}` (`application/json`) is
  read by `readPrototypeEmbedResource` in `src/features/prototype/web/prototypeEmbedResource.ts`.
  Its text is `{format: "automobile-prototype-embed", version: 1, requires, spec}`, where `spec` is
  the stored spec of the variant and revision the web page would show first and `requires` is
  `requiredPrototypeCapabilities(spec)` computed by this host, so the web library can refuse a spec
  it cannot draw whole ([Prototype web library](prototype-web-library.md)). Variant, revision and
  errors are the web resource's; there is no `frame`. `_meta` is the web resource's without
  `frame`, its `sha256` hashing the envelope text.
- **Single-file formats.** `automobile:prototype/{id}/compose{?frame,revision}` (`text/x-kotlin`)
  and `automobile:prototype/{id}/swiftui{?frame,revision}` (`text/x-swift`) are read by
  `readPrototypeSourceResource` in `src/features/prototype/prototypeSourceResource.ts`. They render
  the `automobile:prototype/native` host file (`nativePrototypeTemplates.ts`) with an `inline`
  input: the spec JSON as a string constant (Kotlin splits it into joined literals of at most
  16 384 characters to stay under the JVM's 65 535-byte constant limit), a header comment naming
  the URI, revision, frame, library coordinate, required capabilities and, per referenced asset,
  its bundle path and `automobile:prototype/native/asset?id=…&assetId=…` URI (assets are never
  inlined), and a preview sized to the frame's screen (`@Preview(widthDp, heightDp)`, `#Preview`
  with `.frame`). The native resource's output is unchanged without `inline`. Revision and errors
  follow the web resource; `frame` defaults to `defaultDeviceFrameId` of the format's platform
  (`pixel-9`, `iphone-16`), since the format fixes the platform. The shader and Swift-equivalent
  asset id refusals are the native resource's. `_meta` is `{revision, deviceRevision?, revisions,
  frame, sha256, rendererVersion}`.
- **Listing.** Each known id gets concrete resources
  `automobile:prototype/{id}/{web,embed,compose,swiftui}` named `prototype-{id}-{format}`, titled
  `{id} (web)`, `{id} (embed)`, `{id} (Compose)` and `{id} (SwiftUI)`,
  registered when its first revision appears and unregistered when the id is evicted; each change
  sends `list_changed`. List entries carry no
  `size`, `annotations` or `_meta`, because the registry's entries do not; the read result carries
  `_meta`.
- **Updates.** Every new revision, and every byte-cap pruning of another id's history, sends
  `resources/updated` for the parameter-free URI of every format of the id, and for the web and embed
  URIs of each id in its variant group and of each id in the group it left (or was evicted from), in
  revision order. The concrete resource matches subscriptions
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
  when only latest revisions remain, the least recently revised other id is dropped whole. Each id
  whose history shrinks this way gets a `pruned` event, and each id dropped whole an `evicted` one.
- The daemon keeps one store for the process (`daemonPrototypeSpecRevisions`), outliving any one
  prototype host; a host with injected state gets its own. Nothing is persisted across restarts.

## Page

`buildPrototypeWebPage(input)` in `src/features/prototype/web/webPage.ts` returns one HTML
document, its `sha256`, the frame used, the unsupported nodes of the first view and the revisions
it inlined per variant.

- **Views.** Every inlined revision of every variant is pre-rendered in portrait and landscape,
  once per screen of its outermost stack when that stack has more than one screen (start first,
  then the others in key order; such views carry `data-screen`). The first view is the chosen
  variant's chosen revision (default: latest) in portrait, on its start screen; the rest are
  `hidden`.
- **Controls.** Only five: rotate (portrait/landscape), zoom and pan (fit, 50–400 %, wheel, drag,
  double-click to fit), a variant select (only with more than one variant), a screen select (only
  when some revision in the page has more than one screen view) and the revision history (newest
  first, `r<N> · show|patch`; only when some variant has more than one revision in the page). The
  screen select lists the shown revision's own screen views and is hidden with fewer than two, so
  it never offers a view the page lacks; switching variant or revision keeps the chosen screen
  when the new revision has it, else shows that revision's start. Controls are buttons and a select with labels. A toolbar note says the preview is
  static: taps do nothing, and the controls switch pre-rendered views. Below 720 px wide the
  history sits under the stage, so the stage keeps the width.
- **Script.** `prototypeWebPageRuntime` is inlined from its `toString()`, so it must stay
  self-contained. It only shows and hides views, lists the shown revision's screens in the
  screen select and moves the stage; UI state stays in memory, with no storage, cookies or URL
  changes. It must stay at or below 150 KB.
- **No network.** The CSP is `default-src 'none'`, the script pinned by its SHA-256, inline
  styles, and `data:` images and fonts. The page references no external URL.
- **Budget.** The page is at most 2 MiB. The start screen of each variant's latest revision and
  of the revision shown first are always kept, then their other screens while they fit; older
  revisions are added newest first while their start screen and history entry fit, each followed
  by its other screens while they fit. The shell (head, toolbar with every screen of the shown
  revision, full history list and script) is measured first. If the kept start screens alone do
  not fit, the build fails with an `ActionableError` naming the largest view.
- **Determinism.** The same input yields byte-identical HTML.

## Browser check

`test/features/prototype/web/webScreenshots.integration.test.ts` loads the page of each reference
spec in headless Chromium: `reference-checkout` plus `template-feed-detail`,
`pager-indicator-dots`, `grid-fixed-columns-span`, `material-controls`, `component-gallery` and
`doc-example-2`, each in `pixel-9` and `iphone-16`, portrait (the list is
`webScreenshotCases.ts`). Playwright (`playwright-core`) is a devDependency of this check only;
nothing at runtime drives a browser.

- **Assertions.** The page is served from one fixed URL and every other request is aborted and
  fails the case, on top of the page's own CSP. No console error, page error or
  `securitypolicyviolation` event may occur. Exactly one view is shown, in portrait, with a
  non-zero size; the stage carries the runtime's fitted scale and the zoom label shows it; rotate
  shows the landscape view, wider than tall; a page with a screen select shows exactly the picked
  screen's view.
- **Goldens.** One PNG per case in `test/fixtures/prototype-web/screenshots/`
  (`<spec>--<frame>.png`, plain git blobs, not LFS), taken at 800×800 CSS px, device scale factor 1,
  with every font forced to `"DejaVu Sans", sans-serif` and the caret hidden. No font is bundled. A
  case matches when at most 0.1 % of pixels differ by more than pixelmatch's 0.1 colour distance; a
  different size never matches. A unit test keeps the directory in step with the case list.
- **Running.** `bash scripts/prototype/web-screenshots.sh` runs it (the integration lane skips it
  without `AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS=1`); `--update` rewrites the goldens. It needs the
  Chromium build of the pinned `playwright-core`:
  `node_modules/.bin/playwright-core install --only-shell chromium`. Every case that reaches
  capture writes `<case>.png`, and a pixel mismatch also `<case>.diff.png`, to
  `AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT` (default `scratch/prototype-web-screenshots/`).
- **CI.** The advisory `Prototype Web Screenshots` workflow runs it on Linux nightly, on dispatch,
  and on pull requests that touch the web renderer, its reference fixtures, the check, or
  `package.json`/`bun.lock`. It is not a required check. Goldens are trusted only from that Linux
  Chromium build, whose text anti-aliasing other machines may not match, so a local run can fail on
  pixels alone; when the runner renders differently, the job uploads the
  `prototype-web-screenshots` artifact, and adopting it means reviewing its PNGs and copying those
  other than `*.diff.png` into the golden directory.

## Still renderer

`renderPrototypeStill(spec, {frame, orientation, mode, screen})` in
`src/features/prototype/web/webStill.ts` draws the spec as a still screen and returns an element
tree plus `unsupportedNodes` and `stack` (the outermost stack's screens in key order, its
start and the screen drawn). It renders on
the host, so the page's script only switches between views it was given and never runs spec logic.

- **Input.** The spec after component expansion, with its own `state` and `data`. A stack shows its
  `start` screen; the outermost stack (the first one drawn) shows `screen` instead when it has that
  screen. No action, timer or `request` runs.
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
- **Platform state.** The frame decides `/device/os`, `/device/widthClass` and `/device/posture`
  from the active panel in the drawn orientation: `widthClass` is `compact`, `medium` or
  `expanded` at the contract's 600 and 840 dp breakpoints on Android, and on iOS `regular` on a
  tablet (smallest side 600 dp or more) or a phone at least 896 dp wide, else `compact`. On
  Android an `opened` fold is `flat` and a `half_opened` one `tabletop` (horizontal hinge) or
  `book` (vertical hinge); without a fold, and always on iOS, posture is missing. Other
  `/platform` pointers stay undecided. `{platform:/pointer}` text binds with the data pass: a
  decided value inserts (missing is empty) and an undecided placeholder stays literal.
- **Conditions.** `visibleWhen` evaluates `key` comparisons and decided `platform` pointers with
  `all`, `any` and `not` against spec and platform state. Parts the still cannot decide (`data`
  pointers, undecided `platform` pointers, unknown keys, validity, string operators) stay undecided
  through `all`, `any` and `not`; only an undecided whole condition counts as true, so a node is
  never hidden on a guess.
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
  roles unpainted. Both devices paint nothing behind a window, so the app below shows through;
  the still has no app below, so the screen paints the theme's `background` role (else `surface`),
  or the Material 3 baseline background for the mode when the scheme leaves both unresolved. An explicit `theme.mode` of
  `light` or `dark` wins over the caller's `mode`; `system` or no mode uses the caller's, then
  light.
- **Coverage.** Supported nodes: `box`, `row`, `column`, `stack`, `scroll`, `text`, `spacer`,
  `divider`, `icon`, `button`, `topAppBar`, `textField`, `switch`, `checkbox`, `card`,
  `listItem` (with its leading icon and its trailing switch, checkbox or icon), `pager`, `grid`,
  `carousel`, `bottomNav`, `tabBar`, `iconButton`, `chip`, `slider`, `radioGroup`, `select`,
  `segmentedButton`, `searchBar`, `datePicker`, `timePicker`, `pasteButton` and `bottomSheet`. Where the devices differ,
  the still follows Android, since Material 3 is the spec's baseline. A pager draws only its initial
  page (its numeric `stateKey` value clamped to the pages and truncated, else the first) filling
  it unless it is `wrap` or a fixed `pageSize` sets that axis, inset by `peek`; neighbours a peek
  would reveal are not drawn. Its `dots` indicator is a row of 6 px dots, 8 px apart, the current one
  in `onSurface` and the rest at 0.38 opacity, 8 px above its bottom edge (a vertical pager: a column
  8 px from its right edge), or centred in a 22 px strip when `below`, unless a fixed height (a
  vertical pager: width) under 44 px leaves no room for it, when it overlays as Android does. A grid is a CSS grid of equal
  columns with `spacing` between columns and `runSpacing` (else `spacing`) between rows; a child
  spans its `span` clamped to the columns, takes the cell's width and sits at the top of its row. An
  adaptive grid fits `floor((width + spacing) / (minWidth + spacing))` columns to the screen width,
  so its tracks and clamped spans agree. A carousel draws its items in a clipped row at `itemWidth`,
  `itemSpacing` apart, each masked with a 28 px corner, and keeps an empty slot for a hidden child; it does not resize items as multi-browse or
  hero keylines do. A bottom nav is an 80 px `surfaceContainer` bar whose items draw their icon in a
  64x32 pill (`secondaryContainer` when selected) over a 12 px label, and it pads its bottom edge by
  the safe area, as both devices' navigation bars do, unless an ancestor already applied it. A tab bar
  is a 48 px `surface` row (72 px when a tab has an icon) with an `outlineVariant` bottom divider; the
  selected tab takes `primary` and a 3 px `primary` indicator, the rest `onSurfaceVariant`, and a
  `scrollable` one starts after 52 px with 90 px minimum tabs and clips the rest. Both bars select
  their linked `pager`'s initial page, else their numeric `stateKey`, else the first item. A nav item
  draws its named icon, else a 24 px `surfaceVariant` square, since item images are not inlined. An
  icon button draws the icon placeholder in a 40 px circle inside a 48 px target: `standard` and
  `outlined` (an `outlineVariant` outline) tint it `onSurfaceVariant`, `filled` sits on `primary` and
  `tonal` on `secondaryContainer`; the icon name labels it when no label is authored. A chip with no
  `stateKey` is an outlined assist chip and one with a `stateKey` a filter chip, whatever its
  `variant`, as both devices draw them: 32 px tall with an 8 px radius in a 48 px target, outlined
  in `outlineVariant`, or `secondaryContainer` with a leading check icon while its key is `true`. A
  slider draws its label above a 16 px track, `primary` up to the value and `secondaryContainer`
  after it with a stop dot at its end, and a 4x44 px `primary` thumb at the value: its numeric
  state, else 0, snapped to `step` and clamped to `min`..`max`. A pager fills both axes, and a grid,
  carousel, slider, tab bar, bottom nav, radio group, select or search bar fills its width, unless sized; a row, column, box or card
  around such a child grows on that axis, as a Compose parent does around a `fillMax` child. A text field draws
  its leading and trailing icons. A top app bar draws its navigation icon
  and actions as icon placeholders labelled with their action, and its `variant` sets its height,
  title size and title alignment. A button, switch, checkbox, text field,
  list item, icon button, chip or slider whose `enabledWhen` is decidably false draws disabled. A button draws its `icon` before
  its label, a divider paints its authored colour, text decorations and built-in font
  families map to CSS, and a span keeps its own background. A text field shows `errorText` with error colours when `errorWhen` is
  decidably true, and otherwise its `supportingText`; it draws filled chrome (the native default) or an outline for `outlined`; its label floats above
  a value or placeholder, and sits in an
  otherwise empty field; a multiline field keeps newlines and its `minLines`/`maxLines` (24 px
  lines); a captioned field's wrapper takes its size,
  weight and alignment in the parent. A spacer with no width, height or weight
  fills its line, and a line around one grows to its parent's size on its unsized axes, as a
  Compose parent does around a `fillMaxSize` child. Icons draw as a tinted rounded outline around the icon name's first letter,
  titled with the name, because the glyph set is not inlined. A switch draws its label before a
  Material 3 track whose thumb sits at the end when on; a checkbox draws its box before its label,
  as both devices do. A card hugs its content unless its width is `fill`, as both devices do. A
  `bottomSheet` is open when its `openWhen` key holds exactly `equals` (a missing key keeps it shut)
  and draws nothing in place: like the devices' modal layer, an open one is drawn over its window
  (the screen, a sheet window's region or a floating window's box) after the tree, in tree order, a
  sheet before those inside it, and takes no ancestor's grid cell or consumed insets. It is a scrim
  filling the window (the `scrim` role at 0.4 opacity by default or when named, else the authored
  colour exactly) under a full-width column at the bottom, as tall as its first detent (half, all,
  or `dp` capped at the window), painted `surface` unless an authored background resolves (the still draws no gradients),
  with no corner radius or shadow; it holds a centred 32x4 px `onSurfaceVariant` drag handle with
  8 px around it, unless `dragHandle` is false, then its child. Choice controls select the option
  whose `value` their `stateKey` holds and tag each option `<testTag>.<value>`. A radio group is a
  column of 48 px rows, a 20 px radio ring (`primary` with a dot when selected) before each label. A
  select draws only its closed field, since its list opens on tap: a 4 px-radius
  `surfaceContainerLow` field with its `label` in `labelSmall` over the chosen label and an
  `expand_more` icon. A segmented button is a row of equal-width 40 px outlined segments, the ends
  rounded, the selected one `secondaryContainer` with a check. A search bar draws a 56 px
  `surfaceContainerHigh` pill with its leading icon, its query (else the placeholder in
  `onSurfaceVariant`) and its trailing actions; while its `activeKey` is `true` it draws its child
  below, and the `bar` variant then fills its height too. A paste button is a filled button
  labelled "Paste". A time picker draws its hour (selected, `primaryContainer`) and minute boxes, an
  AM/PM selector unless it is 24-hour (`is24Hour`, else the still's `en-US` 12-hour clock), and a
  256 px hour dial (a 24-hour dial adds an inner 12–23 ring) with the bound hour under a `primary`
  selector. A date picker is 360 px of `surfaceContainerHigh`: "Select date", the bound date as its
  headline, the month row with its arrows, and that month (else today's from the still's clock) in
  a Sunday-first grid of 48 px cells, the bound day filled `primary` and today ringed. An `image` draws a placeholder with reason `assetNotInlined`. Any other node draws a
  dashed placeholder labelled with its type and id, with reason `unsupportedType`.
- **Frame.** The screen has the frame's size for the orientation, its corner radius and bezel, a
  generic status bar, the cutout and the navigation handle (or three generic button marks, which move to
  the right edge in landscape when the frame reserves that inset). Landscape swaps the screen size, uses
  the landscape safe areas, and moves the cutout from the top edge to the left edge. A frame whose
  landscape top inset is 0 (an iPhone) draws no status bar in landscape. `safeAreaPadding` adds the inset on each named edge to the node's padding; like
  `windowInsetsPadding`, an edge an ancestor already applied adds nothing more, and an inset adds to a component's own
  padding on that edge (`ime` adds nothing,
  since the still has no keyboard). Safe areas are exposed as
  `--safe-top`, `--safe-bottom`, `--safe-left` and `--safe-right`. Both devices draw a
  window's content edge to edge and a top app bar takes no inset of its own, so it clears the
  status bar only through `safeAreaPadding`.
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
