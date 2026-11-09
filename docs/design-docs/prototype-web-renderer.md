# Prototype web renderer

The web renderer draws a prototype inside a device frame as one self-contained HTML page. This
document covers the per-prototype resources (the page, the embed envelope and the single-file
Compose and SwiftUI sources), spec revisions, the page, its browser check, the still renderer and the device frame
registry.

## Resource

`automobile:prototype/{id}/web{?frame,revision,variant,mcpSessionId}` (`text/html`) is registered in
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
- **Session filter.** `mcpSessionId` narrows the lookup to the revisions that MCP session produced
  (`PrototypeSpecRevisionFilter`): the default revision is that session's latest, `revisions`
  lists only its own, and a revision of another session, or a session with none kept, is an
  `ActionableError`. The page's inlined history is not filtered, so variants without a revision
  from that session still render.
- **Read result.** `_meta` is `{revision, deviceRevision?, mcpSessionId?, revisions, variants,
  frame, sha256, rendererVersion}`; `mcpSessionId` is the producing session of the revision shown
  first and `rendererVersion` is the server release version.
- **Embed envelope.** `automobile:prototype/{id}/embed{?revision,variant,mcpSessionId}` (`application/json`) is
  read by `readPrototypeEmbedResource` in `src/features/prototype/web/prototypeEmbedResource.ts`.
  Its text is `{format: "automobile-prototype-embed", version: 1, requires, spec}`, where `spec` is
  the stored spec of the variant and revision the web page would show first and `requires` is
  `requiredPrototypeCapabilities(spec)` computed by this host, so the web library can refuse a spec
  it cannot draw whole ([Prototype web library](prototype-web-library.md)). Variant, revision, the session
  filter and errors are the web resource's; there is no `frame`. `_meta` is the web resource's without
  `frame`, its `sha256` hashing the envelope text. When any glyph the spec names resolves, the envelope
  carries `glyphs` (additive within version 1) and, when any has no glyph, `iconMissing`, built by
  `prototypeEmbedGlyphs` from the same `PrototypeIconGlyphSource` as the still. The keys are
  collected statically from the contract over the component-expanded spec, not from a render: every `iconName` slot in its object's
  `iconVariant` (else `filled`), the glyphs a control draws with no `iconName` slot (filter chip and segment checks, the select arrow, the date picker's month arrows), plus every iconName-valid string in `state` or `data` in `filled`
  and each variant an icon node uses, because a state change can hand that name to any icon. A
  value is the allow-listed shapes as SVG markup. iOS-skin glyphs are not included.
- **Single-file formats.** `automobile:prototype/{id}/compose{?frame,revision,mcpSessionId}` (`text/x-kotlin`)
  and `automobile:prototype/{id}/swiftui{?frame,revision,mcpSessionId}` (`text/x-swift`) are read by
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
  asset id refusals are the native resource's. `_meta` is `{revision, deviceRevision?, mcpSessionId?,
  revisions, frame, sha256, rendererVersion}`.
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
- The store is shared by every MCP connection on the daemon, so each revision keeps the connection
  that produced it as `mcpSessionId` (`currentConnectionMcpSessionId()` at the prototype tool call,
  the identity autolock and ownership already use); a call with no connection records none. The
  tool's show and patch output return the same id so a client can filter by it. It is attribution
  only: prototype status scopes and the shown-spec mirror stay keyed by device.
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

- **Views.** Every inlined revision of every variant is pre-rendered in each orientation the frame
  has (portrait and landscape; portrait only for a watch; landscape only for a TV or car) and in
  every posture of a foldable frame (such views carry `data-posture`), once per screen of the
  outermost stack each orientation and posture draws when that stack has more than one screen
  (start first, then the others in key order; such views carry `data-screen`), since a
  `visibleWhen` can show a different stack in each. The first view is the chosen variant's chosen
  revision (default: latest) in the frame's first orientation (`data-orientation` on `body`), in
  the frame's default posture, on its start screen; the rest are `hidden`. Views are kept or
  dropped by screen index: every orientation and posture's start together, then each one's next
  screen together. Every view renders in the input's `locale` and `textSize`, passed to the still.
- **Controls.** Only seven: rotate (portrait/landscape; absent for watch, TV and car frames, which
  have one orientation), a layout posture select (`layout-posture`, only for a frame with postures,
  in registry order; switching shows that posture's views and fits the new view), zoom and pan
  (fit, 50–400 %, wheel, drag, double-click to fit), the opt-in 3D view
  ([Prototype web 3D device view](prototype-web-3d.md); posture and hinge controls only for a frame
  with a hinge and postures), a variant select (only with more than one variant), a screen select (only
  when some revision in the page has more than one screen view) and the revision history (newest
  first, `r<N> · show|patch`; only when some variant has more than one revision in the page). The
  screen select lists the shown revision's own screen views and is hidden with fewer than two, so
  it never offers a view the page lacks; switching variant or revision keeps the chosen screen
  when the new revision has it, else shows that revision's start. Rotating or changing posture
  relists the shown view's own screens. Controls are buttons and a select with labels. A toolbar note says the preview is
  static: taps do nothing, and the controls switch pre-rendered views. Below 720 px wide the
  history sits under the stage, so the stage keeps the width.
- **Script.** `prototypeWebPageRuntime`, then `prototypeWeb3dRuntime`, are inlined from their
  `toString()` into the one pinned script, so each must stay self-contained. It only shows and hides views, lists the shown revision's screens in the
  screen select, moves the stage and animates rotation; UI state stays in memory, with no storage, cookies or URL
  changes. It must stay at or below 150 KB.
- **Rotation.** Rotate turns the frame 90° (counterclockwise into landscape, clockwise back)
  with the Web Animations API: the outgoing view turns away from upright while the incoming view,
  pre-rendered in the new orientation, turns in from a quarter turn, so both track one frame, and
  the stage's fitted scale animates with them. Android (`data-platform` on `body`) cross-fades
  the content over a 500 ms turn; iOS hands over to the new layout in the first quarter of a
  400 ms turn, as its window re-lays out while the bounds animate. The end state is the plain
  landscape view. A second rotate finishes the running turn first. `prefers-reduced-motion:
  reduce` skips the animation.
- **No network.** The CSP is `default-src 'none'`, the script pinned by its SHA-256, inline
  styles, and `data:` images and fonts. The page references no external URL, and declares an
  empty `data:` icon so no browser requests `/favicon.ico` against that CSP.
- **Budget.** The page is at most 2 MiB. The start screen of each variant's latest revision and
  of the revision shown first are always kept, then their other screens while they fit; older
  revisions are added newest first while their start screen and history entry fit, each followed
  by its other screens while they fit. The shell (head, toolbar with every screen of the shown
  revision, full history list and script) is measured first. If the kept start screens alone do
  not fit, the build fails with an `ActionableError` naming the largest view.
- **Images.** `buildPrototypeWebPageWithImages` (`webImageEncoding.ts`) builds the page once to
  learn every bound asset an `image` draws and its boxes, reads each asset's bytes from a
  `PrototypeWebAssetSource`, re-encodes it with sharp (`loadSharp`) to WebP quality 80 at the
  largest size the frame draws it, and builds again with the encoded images. An iOS frame applies
  the EXIF orientation first, as `UIImage(data:)` does; an Android frame keeps the stored pixels,
  as `BitmapFactory` ignores the tag. A box is the frame
  density times the node's fixed dp size; `crop` and `fill` must cover their fixed axes and, when
  one axis is fixed, their `fill` axes at the screen's long side (the landscape width); `fit` and
  other unfixed axes fit inside the long side; the image is never enlarged. When the encoded
  images do not all fit the budget, assets with such a `fill` axis are re-encoded with it bounded
  by the screen's short side (the portrait width), and the page keeps the longest prefix of images,
  in budget order, at their long-side encodes that still inlines as many images as all-compact
  encodes would. A missing, non-image
  or undecodable asset (logged) is skipped, and one whose data URI alone exceeds the page is
  reported `assetOverBudget`; the page budget decides which of the rest fit. An image draws more markup than a placeholder, so when the
  second build's always-kept views no longer fit, the first build stands, its images reported
  `assetOverBudget`. The resource reads assets from the host asset cache of each device currently
  showing one of the variants (Android caches its uploads); without one, images stay placeholders.
  Asset ids are chosen per device and the page holds one image per id, so an id two of those
  devices cached with different bytes stays a placeholder.
  It snapshots the shown variant's revisions before encoding, so a revision landing meanwhile does
  not change the page's `_meta`.
- **Image budget.** Each image is one `:root` rule in the head defining `--pa-<slot>` (its
  `data:image/webp` URI), `-bg` (transparent), `-ar` (its aspect ratio) and `-on` (1); views only
  reference the slot, so view bytes do not depend on which images fit and every orientation and
  revision shares one copy. A rule is charged once, in this order: the images of the shown
  revision's start screen, then of the other pinned start screens, then each screen's images right
  after that screen is kept. Within one build an image that does not fit is never retried and
  draws its placeholder; it is reported `assetOverBudget`, and one with no bytes `assetNotInlined`.
- **Determinism.** The same input yields byte-identical HTML.

## Browser check

`test/features/prototype/web/webScreenshots.integration.test.ts` loads the page of each reference
spec in headless Chromium, Firefox and WebKit: `reference-checkout` plus `template-feed-detail`,
`pager-indicator-dots`, `grid-fixed-columns-span`, `material-controls`, `component-gallery`,
`doc-example-2`, `native-controls` (every button variant and two sliders) and `image-gallery`
(its assets are `test/fixtures/prototype-web/assets/<id>.png`), each in `pixel-9` and `iphone-16`, portrait,
and `reference-checkout` alone in each watch, TV and car frame (the list is
`webScreenshotCases.ts`). Playwright (`playwright-core`) is a devDependency of this check only;
nothing at runtime drives a browser.

- **Assertions.** The page is served from one fixed URL and every other request is aborted and
  fails the case, on top of the page's own CSP. No console error, page error or
  `securitypolicyviolation` event may occur. Exactly one view is shown, with a non-zero size, in
  the frame's first orientation; the stage carries the runtime's fitted scale and
  the zoom label shows it; a watch, TV or car page has no rotate control; on other frames, halfway
  through rotate both views are shown and turned, and the finished turn shows only the landscape
  view, wider than tall; with reduced motion, rotate starts no animation; a page with a screen select shows exactly the picked
  screen's view; the 3D toggle turns the shown view to the three-quarter pose, an arrow key on the
  focused viewport orbits it, and toggling back restores the shown view's DOM byte for byte. The
  browser clock is fixed at 9:41 UTC, so the live status bar clock matches the stills; a separate
  case installs a running clock and checks the clock advances each minute. Another checks that
  only an overflowing scroll fades, or, in an engine without scroll-driven animations, that every
  scroll does. Every engine runs these assertions; CSS 3D and clipping differ between engines, so
  a page that only works in Chromium fails here.
- **Settings cases.** `reference-checkout` also renders in both phone frames at the largest text size
  (`fontScale` 2, `accessibility-extra-extra-extra-large`) and in the `ar` locale (RTL), golden
  `<spec>--<frame>--<setting>.png` (and `--landscape.png` after it).
- **Goldens.** Compared only in Chromium, the one engine whose CI build they are trusted from.
  One PNG per orientation of the case's frame in `test/fixtures/prototype-web/screenshots/`
  (`<spec>--<frame>.png` as the page opens and, on a frame that rotates,
  `<spec>--<frame>--landscape.png` at the end of the turn; plain git blobs, not LFS), taken at
  800×800 CSS px, device scale factor 1,
  with every font forced to `"DejaVu Sans", sans-serif` and the caret hidden. No font is bundled. A
  case matches when at most 0.1 % of pixels differ by more than pixelmatch's 0.1 colour distance; a
  different size never matches. A unit test keeps the directory in step with the case list.
- **Running.** `bash scripts/prototype/web-screenshots.sh` runs it (the integration lane skips it
  without `AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS=1`); `--update` rewrites the goldens, and
  `--engine <chromium|firefox|webkit>` (repeatable) limits the engines. It needs the browser builds
  of the pinned `playwright-core`:
  `node_modules/.bin/playwright-core install --only-shell chromium firefox webkit`. Every case that
  reaches capture writes `<case>.png`, and a Chromium pixel mismatch also `<case>.diff.png`, to
  `AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT` (default `scratch/prototype-web-screenshots/`);
  Firefox and WebKit captures go to its `firefox/` and `webkit/` subdirectories.
- **CI.** The advisory `Prototype Web Screenshots` workflow runs it on Linux nightly, on dispatch,
  and on pull requests that touch the web renderer, its reference fixtures, the check, or
  `package.json`/`bun.lock`. It is not a required check. Goldens are trusted only from that Linux
  Chromium build, whose text anti-aliasing other machines may not match, so a local run can fail on
  pixels alone; when the runner renders differently, the job uploads the
  `prototype-web-screenshots` artifact on every run, and adopting it means reviewing its top-level
  PNGs and copying those other than `*.diff.png` into the golden directory.

## Android parity check

`test/features/prototype/web/webAndroidParity.integration.test.ts` measures how far the still is
from the Android renderer. For each Roborazzi golden in
`android/control-proxy/src/test/resources/screenshots/prototype/`, `webAndroidParityCases.ts`
either rebuilds the spec the Kotlin case renders (fixture, `night`/`notnight` mode, state
overrides, `themeFrom` and the case's JSON edit) or lists the golden with a reason; host window
chrome and content-sized floating captures are listed, not compared. Every compared spec is placed
fullscreen, because the goldens draw the root and theme without the window's placement.

- **Rendering.** The still is drawn `chromeless` on the `small-phone` frame (360×640 dp, the
  goldens' `w360dp-h640dp-mdpi`, so one dp is one pixel) into a bare document with no page shell,
  at device scale factor 1 with the same forced font as the page check. Chromeless drops the
  bezel, bars, cutout, corner radius, safe-area insets and window background, because the goldens
  capture the content path with no window and are transparent where nothing draws; the screenshot
  omits the page background to match. A golden smaller than the screen is compared with the
  screen's top-left region of its size.
- **Budgets.** `test/fixtures/prototype-web/android-parity-budgets.json` maps each compared golden
  to the most pixels that may differ by more than pixelmatch's 0.1 colour distance. A case fails
  when it differs in more than its budget plus 256 pixels or 1 %, whichever is larger: hosted
  runners do not all rasterize alike, so the same commit's counts move slightly between CI runs.
  The allowance never reaches the golden's pixel count, so a screenshot that differs everywhere
  fails. Budgets only shrink: `--update` lowers each to what was measured and
  records a missing one, and raises one only with `--allow-grow`. The counts are measured by the
  CI Chromium build; every run logs them on one `android parity diff pixels:` line. A unit test
  keeps the case table, the skip list and the budget keys in step with the golden directory.
- **Output.** `<golden>.png` and, when any pixel differs, `<golden>.diff.png` go to
  `android-parity/` under the output directory, uploaded with the page check's artifact.

## Still renderer

`renderPrototypeStill(spec, {frame, orientation, posture, mode, screen, locale, textSize, chromeless})` in
`src/features/prototype/web/webStill.ts` draws the spec as a still screen and returns an element
tree plus `unsupportedNodes` and `stack` (the outermost stack's screens in key order, its
start and the screen drawn). It renders on
the host, so the page's script only switches between views it was given and never runs spec logic.

- **Input.** The spec after component expansion, with its own `state` and `data`. A stack shows its
  `start` screen; the outermost stack (the first one drawn) shows `screen` instead when it has that
  screen. No action, timer or `request` runs.
- **Text.** String-table translations resolve first, in the caller's `locale` (BCP 47, canonicalized;
  default `en-US`; an invalid tag is a `PrototypeWebInputError`, surfaced to clients as an
  `ActionableError` with the same message). Then
  `{data:/pointer}` placeholders bind (a missing or non-scalar value is empty),
  then repeat items, then a bare `{key}`, which reads spec state, and `{derived:name}`, which reads a
  top-level `derive` entry. Repeat placeholders
  bind each object item (a literal `items` array or a data pointer; scalar items are skipped
  before indices are assigned, as on devices), including the repeat's own `derive`
  fields. A repeat draws at most 200 items, except a `list`, which draws up to the list contract
  limit (2,000) capped by its `maxItems`, as devices do. A 2,000-row list of plain list items is
  about 0.7 MB of markup, inside the page budget; a page whose kept start screens exceed it fails
  the build as described under **Budget**. Text binds once, in that order: every inserted data or repeat value is shielded until binding
  ends, so it is never read again as a placeholder. Nested conditions with typed operands and state keys bind through the devices' own
  field walk (`mapBindableFields`). A spans-only text node renders each span
  with its own text style. A `secure` or `password` text field shows its value masked. Formatting uses the locale, `UTC` and a
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
  mirrored); without one, a locale whose language or script is written right to left (Arabic,
  including `ar-XB`, Hebrew, Persian, Urdu and the like) sets `rtl`, as a device in that locale
  does, and any other locale leaves the page's direction. In either case `start`/`end` safe-area edges read the inset on the matching physical side. Fullscreen fills the screen, and a fullscreen or sheet root fills its window on
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
- **Style polish.** A `gradient` paints over the background across the whole node: a linear
  angle is clockwise from left-to-right (CSS's angle plus 90) and a radial one is centred and
  reaches the corners; stop positions apply only when every stop has one, made non-decreasing.
  `shadows` map to `box-shadow` with the authored blur as the CSS blur (sigma b/2), and `elevation`
  takes its `shadowColor` tint. A gradient border and inner shadows are absolutely placed layers
  after the node's children, so they paint over the content, inside its bounds, as Compose draws
  them. `surface: "glass"` is a capsule unless `cornerRadius` shapes it: the iOS skin blurs and
  saturates the backdrop under a translucent tint (else white) with a light rim, and the Android
  skin draws the tonal fill (the tint, else `surfaceContainer`, at 0.85); an authored background
  keeps its colour. `ios.glassGroup` draws nothing of its own. `scroll.fadeEdges` is a mask on the
  trailing edge only (the leading one in a `reverse` scroll), since a still opens at the scroll's
  start; horizontal start and end mirror in RTL. The still cannot measure overflow, so it hands the
  mask to the page as `--fade-mask`, and a scroll-driven animation on a `scroll(self)` timeline
  applies it: that timeline is inactive while the content fits, so only an overflowing scroll
  fades, as Android draws a fade only while it can scroll forward. It depends on layout, not time,
  so screenshots stay deterministic; a browser without scroll-driven animations always fades. `linkify` splits the
  resolved text into plain runs and one `data-link` span per match in its `style`, and a span with
  `onTap` is marked the same way; links get no style of their own, as on Android. A
  `zoomable` image draws at 1x. A node with `style.shader` draws without it, as a device without
  shader support does, and is listed with reason `shaderFallback`.
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
  controls (app bar title, field label, caption and lines, list item text); icons and the device
  chrome do not scale. The default size (`1`, `large`) renders the same bytes as none.
- **Colour.** Theme roles resolve from the Material 3 baseline, then the roles a `theme.colors.seed`
  derives, then the explicit overrides. The seed roles are the HSL approximation both devices
  share (`prototypeSeedScheme.ts`, Android's `prototypeSeedColorScheme`, the iOS agent's
  `seedScheme`), rounded to 8-bit channels as Compose stores them. A `device` source has no
  device scheme to read, so it falls through to the seed or the baseline, as iOS and Android
  below API 31 do. The accessibility lint still treats a seed or device scheme as unknown. Both
  devices paint nothing behind a window, so the app below shows through; the still has no app
  below, so the screen paints the theme's `background` role (else `surface`).
- **Mode.** The still resolves light or dark in the devices' order: an explicit `theme.mode`;
  with no mode, the luminance of the flat `theme.colors.background` (else `surface`) override,
  then of the first opaque hex background on the root's leading chain (the first child that
  draws in place, so a hidden node or a closed sheet is passed over; a pager's current page, a
  scroll's `child`, a stack's drawn screen; role and `{light, dark}` backgrounds are passed
  over); last the
  caller's `mode`, then light. `theme.mode: "system"` goes straight to the caller's. As on
  Android, an authored colour of the resolved mode's polarity replaces `background`, `surface`
  and `surfaceContainer`/`Low`/`High`/`Highest` unless a seed or device source derives the scheme;
  role overrides still win over it.
- **Coverage.** Supported nodes: `box`, `row`, `column`, `stack`, `scroll`, `text`, `spacer`,
  `divider`, `icon`, `button`, `topAppBar`, `textField`, `switch`, `checkbox`, `card`,
  `listItem` (with its leading icon and its trailing switch, checkbox or icon), `pager`, `grid`,
  `carousel`, `flow`, `list`, `bottomNav`, `tabBar`, `iconButton`, `chip`, `slider`, `radioGroup`,
  `select`, `segmentedButton`, `searchBar`, `datePicker`, `timePicker`, `pasteButton`, `badge`,
  `progress`, `fab`, `chart`, `adaptive`, `bottomSheet`, `dialog`, `snackbar`, `videoPlayer`, `map`,
  `cameraPreview` and `castButton`, and a `row` or `listItem`'s `swipeActions`. Where the devices differ,
  the skin decides (below); the descriptions here are the Android skin's. A pager draws only its initial
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
  hero keylines do. A flow places its children eagerly in lines, `spacing` apart, starting a new
  line `runSpacing` below when `used + spacing + width` would exceed its width, hugs its widest line
  and clamps to `maxLines` lines. A `list` draws its header, every repeated row up to `maxItems` and
  its footer, `spacing` apart inside `contentPadding`, in a column (filling, scrolling vertically) or
  a row (scrolling horizontally), at its opening scroll position. A badge is a 6 px `error` dot, or a 16 px `error` pill around its
  text. A progress indicator is a 240x4 px bar or a 40 px ring on a `secondaryContainer` track, its
  `primary` indicator at its numeric state over `max` (default 1) clamped to 0..1; unbound it is
  indeterminate and a still rests it at 30 %. A FAB is 40, 56 or 96 px (`small`, regular, `large`)
  on `primaryContainer`, or extended with its label; disabled it is a 12 % `onSurface` container. A
  chart is inline SVG with Android's geometry: a 160 px plot filling the width (lines, filled areas
  at 0.25 opacity, or grouped bars rising from zero) over its `yRange` or the auto range, a dashed
  `outline` goal line, x labels below, or a 120 px ring of the latest value over the goal; series
  without a `color` take `primary`, `tertiary`, `secondary`, `error` in turn, and the device summary
  is its label unless one is authored. An `adaptive` scaffold lays out by the screen's width class
  (compact below 600 px, expanded from 840 px): list-detail and supporting panes sit side by side
  (a 360 px pane, a 24 px spacer) only when expanded, else the detail (after a selection, with Back)
  or the open supporting pane (with Close) replaces the other; a navigation suite is a bottom bar,
  a rail or a drawer by width class, each item drawing its label's first letter as its icon. Swipe
  actions are drawn as hidden `start` and `end` panels, since a still shows the item closed. A bottom nav is an 80 px `surfaceContainer` bar whose items draw their icon in a
  64x32 pill (`secondaryContainer` when selected) over a 12 px label, and it pads its bottom edge by
  the safe area, as both devices' navigation bars do, unless an ancestor already applied it. A tab bar
  is a 48 px `surface` row (72 px when a tab has an icon) with an `outlineVariant` bottom divider; the
  selected tab takes `primary` and a 3 px `primary` indicator, the rest `onSurfaceVariant`, and a
  `scrollable` one starts after 52 px with 90 px minimum tabs and clips the rest. Both bars select
  their linked `pager`'s initial page, else their numeric `stateKey`, else the first item. A nav item
  draws its named icon, else a 24 px `surfaceVariant` square, since item images are not inlined. An
  icon button draws its icon in a 40 px circle inside a 48 px target: `standard` and
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
  and actions as icons labelled with their action, and its `variant` sets its height,
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
  Compose parent does around a `fillMaxSize` child. In an Android frame an icon draws its Material Icons
  glyph (the set Compose's `material-icons-extended` bundles, read from the Apache-2.0
  `@material-design-icons/svg` package) as inline SVG in a 24 px box, in its `variant`'s style, else
  `filled` as Android falls back, and tinted by `currentColor` or its style `color`. Only the
  glyphs a still draws are read and inlined. The still takes its glyph source as an option, so it
  stays free of Node builtins for the browser bundle: the server's page builder passes the
  Material Icons reader, and a still given none draws every icon as the placeholder, unreported.
  A glyph that would need `<defs>`/`<use>` ids is
  treated as absent, since ids collide when a page draws it twice. A name with no glyph draws a
  tinted rounded outline around its first letter, titled with the name, with reason `iconMissing`.
  An iOS frame draws that outline for every icon, unreported, until its glyph set is decided
  (#16526). A switch draws its label before a
  Material 3 track whose thumb sits at the end when on; a checkbox draws its box before its label,
  as both devices do. A video player is a black 16:9 frame (a `colorBars` sample draws bars, a
  `countdown` sample a 3; other sources are not inlined) under the skin's chrome at `startMs`
  (Android: a centred 56 px play button over a bottom bar; iOS: play inside a rounded bottom bar),
  with a CC button when it has captions and none when `controls` is `none`; a poster is listed
  `assetNotInlined`. A map fetches no tiles: it draws a neutral canvas (`plain`, or a faint street
  grid), 200 px tall unless sized, with its polylines in an inline SVG and its markers as pins, placed
  by Web Mercator under `fit` (`markers` or `route`), else the camera (literal or `/data`), else every
  point. Points are placed in dp from the box centre (`calc(50% + …px)`, the SVG's origin at the
  centre), so CSS resolves them against the box as rendered. A width or height the parent sizes
  (`fill`, a `weight` on the parent's main axis, a stretched width, the fullscreen root) cannot be
  known when rendering, so the framing and perspective use the screen's size on that axis, the most
  the box can take. Each axis is then held within its `min*`/`max*` (the min wins, as in CSS), and an
  `aspectRatio` sizes the open axis from the other: in a column the height follows the width (the
  200 px default is dropped so the ratio applies); in a row, a box or the root an open width follows
  the height. A ratio with no width, height or weight takes the width it is offered, capped at
  `maxHeight × ratio`, as the style sizes it. That keeps a camera's true zoom at any box size; a fit (`fit`, or every point
  when there is no camera) instead chose its zoom to span 80% of that size, so its pins scale by
  `min(100cqw / width, 100cqh / height)` (the box a size container) and its SVG, `100cqw` × `100cqh` about the
  same centre so padding moves pins and lines alike, takes the fitted size as a `meet` viewBox and a non-scaling stroke: a box rendered narrower than the
  screen shrinks the fit uniformly and keeps every point inside. A camera framing turns
  by its `bearing` and `tilt` (a fit frames north up): the canvas moves to a ground square under `perspective(1.5 × height) rotateX(tilt) rotate(-bearing)`, sized from the
  box corners traced back onto the plane so it covers any aspect ratio, and lines and pins are
  projected the same way in code: pins stay upright, and lines are clipped at a near plane (0.1 of the
  eye distance) and break into separate runs there, while pins past it are dropped. Because the
  height used is never less than the rendered one, the eye is far enough out that no horizon shows.
  A camera preview is a portrait viewfinder at its
  `aspectRatio` (default 4:3) showing colour bars and a label naming its mode. A cast button is the
  skin's idle route icon (Cast on Android, AirPlay on iOS) in a 48 px target; it is a `details`
  disclosure, so a tap opens a device picker listing no devices without any script. Glyphs are inline
  SVG; the serializer allows only `viewBox` and `preserveAspectRatio` as mixed-case attributes.
  A card hugs its content unless its width is `fill`, as both devices do. A
  `bottomSheet` is open when its `openWhen` key holds exactly `equals` (a missing key keeps it shut)
  and draws nothing in place: like the devices' modal layer, an open one is drawn over its window
  (the screen, a sheet window's region or a floating window's box) after the tree, in tree order, a
  sheet before those inside it, and takes no ancestor's grid cell or consumed insets. It is a scrim
  filling the window (the `scrim` role at 0.4 opacity by default or when named, else the authored
  colour exactly) under a full-width column at the bottom, as tall as its first detent (half, all,
  or `dp` capped at the window), painted `surface` unless an authored background resolves,
  with no corner radius or shadow; it holds a centred 32x4 px `onSurfaceVariant` drag handle with
  8 px around it, unless `dragHandle` is false, then its child. A `dialog` and a `snackbar` open
  and layer the same way. A dialog is a scrim (the `scrim` role at 0.32) under a centred
  `surfaceContainerHigh` surface with 28 px corners, 24 px padding and 16 px gaps, 280 to 560 px
  wide with 24 px around it: its icon (`secondary`), title (`headlineSmall`, `onSurface`), text
  (`bodyMedium`, `onSurfaceVariant`), its child (scrolling when tall), then the dismiss and confirm
  text buttons (`labelLarge`, `primary`) at the end, tagged `<testTag>.dismiss` and
  `<testTag>.confirm`. A snackbar has no scrim and lets touches through around it; it sits at the
  window's bottom with 12 px around it, as wide as the window up to 600 px, at least 48 px tall,
  in `inverseSurface` with 4 px corners and `bodyMedium` `inverseOnSurface` text, then its
  optional `inversePrimary` action tagged `<testTag>.action`. Choice controls select the option
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
  a Sunday-first grid of 48 px cells, the bound day filled `primary` and today ringed. An `image` binds its asset id (a
  light/dark pair picks the mode's side, then placeholders bind as text does); without a slot for it
  it draws a `surfaceVariant` placeholder, at least 48 px on each axis the node does not fix in dp,
  with reason `assetNotInlined`. With one, the placeholder
  colour and an `aspect-ratio` on an axis it leaves to wrap read the slot's `-bg` and `-ar`, and it
  holds an image layer (the slot's image as a centred background, `contain`, `cover` or
  `100% 100%` for `fit`, `crop` and `fill`, with `saturate()` for `filter.saturation`) and, for
  `filter.tint`, a tint layer that multiplies the tint's opaque colour over the image masked by it,
  shown only when `-on` is set, as Android's saturation colour matrix then its `Modulate` tint
  layer. `Modulate` multiplies alpha too, so a translucent tint wraps both layers in a group at the
  tint's alpha (a fully transparent tint hides the image); a corner radius clips both. Item images (nav items) are not inlined. Any other node draws a
  dashed placeholder labelled with its type and id, with reason `unsupportedType`.
- **Posture.** A foldable frame draws the panel its `posture` lights (default `opened`, else its
  first posture; a frame without postures takes none, and an unknown posture is an error listing
  the frame's): `closed` draws the cover panel. The spec lays out on that panel in the drawn
  orientation, minus an occluding hinge's width, shown in the two segments either side of the
  hinge (the second copy `aria-hidden` and inert); a seamless fold lays out across the whole
  panel and draws a crease shaded by its `hingeDegrees`, none when flat. Landscape turns the
  hinge with the panel, so a flip's hinge runs top to bottom there.
- **Skins.** `webSkin.ts` holds one skin per platform; the frame's platform picks it and the
  `skin` option overrides it. A skin replaces the renderers of the components its platform draws
  natively (`designCoverage` `native` in `schemas/prototype-spec-contract.json`), and those of the
  Material components the iOS renderer draws with SwiftUI defaults; every other component draws
  the shared Material 3 renderer on both. A node's `ios` namespace is read only in
  the iOS skin and its `android` namespace only in the Android one. The Android skin replaces
  nothing. The iOS skin draws `button` as the iOS renderer's SwiftUI styles at the regular control
  size in the 17 px body style (scaled by the frame's Dynamic Type size), tinted with the theme's `primary`: `filled` is a 6 px-radius tint fill
  under white text with 7x12 px padding, `tonal` the tint at 0.15 opacity under tint text,
  `elevated` that with a 1 px shadow, `outlined` a 1 px tint capsule with 8x16 px padding, `text`
  bare tint text; `ios.buttonStyle` draws `glassProminent` as a filled and `glass` as a tonal
  capsule, without blur. Its `slider` is the system slider: its label 4 px above a 28 px row whose
  4 px track is systemBlue up to the value and systemFill after it, under a white 28 px thumb whose
  centre travels 14 px inside each end; the value is its state, else `min`, clamped and not
  snapped. Its Material components follow the iOS renderer's SwiftUI views (text sizes are
  body 17, subheadline 15, `.title3` 20, `.title` 28 and `.largeTitle` 34 px, scaled by the frame's
  Dynamic Type size): `switch` is a body label filling a 44 px row before a 51x31 capsule track (`primary` on,
  `surfaceContainerHighest` off) with a 27 px thumb; `checkbox` is a 17 px check square, filled
  when checked, 8 px before its label; `listItem` has a body headline over a subheadline
  `onSurfaceVariant` supporting line, 56 px tall or 72 px with one, and that switch track or check
  square as its trailing control; `chip` is 32 px with 12 px padding in the medium subheadline style
  and the content colour, in a 44 px target; `topAppBar` is a 64 px row padded 4 px with 48 px icon
  buttons and a `.title3` semibold title (12 px in, 4 px after a navigation icon), or a `.title`
  (medium) or `.largeTitle` (large) line below the row, framed at 48 or 88 px with an
  `enterAlways` or `exitUntilCollapsed` `onScroll`; `card` is `surfaceContainerHigh` when
  filled, else `surface`, with an `outlineVariant` outline when outlined. Like the iOS renderer,
  the skin ignores `ios.navigationTitle` and `ios.sheet.sizing`. `textField` with a label,
  variant, supporting text or `maxLength` puts its `.footnote` `onSurfaceVariant` label 4 px above
  an input padded 12 px (`filled`: a `surfaceContainerHighest` fill with 4 px top corners over a
  1 px `outline` line; `outlined`: a 1 px 4 px-radius `outline` stroke; red on an error) and a
  `.caption` row of supporting text and the `count/max` counter below; otherwise it is a
  rounded-border input. The label never floats, an empty field shows only its placeholder, icons sit
  4 px beside the field and the error message is a red `.caption` line below it. `bottomNav`
  spaces items 8 px on `surfaceContainer`, padded 12 px above and 4 px below, each a 64x32
  `secondaryContainer` capsule over a `.caption` label (semibold when selected, else medium) in at
  least 64 px. `tabBar` has no background or divider: each tab is its icon over a `.caption` label,
  2 px apart, at least 44 px tall (64 px when it minimizes), the selected one in a capsule. An
  iOS `bottomSheet` centres its child 8 px below a 36x5 handle 6 px from the top, on `surface`
  with a 16 px radius. `timePicker`, `datePicker` and `pasteButton`
  are still placeholders on both skins.
- **Frame.** The screen has the frame's size for the orientation, its corner radius and bezel, a
  generic status bar, the cutout (an `island` draws as a pill, a punch hole as a circle) and the
  navigation chrome: Android's handle (`data-nav="handle"`) or three generic button marks, which move to
  the right edge in landscape when the frame reserves that inset, and iOS's home indicator
  (`data-nav="homeIndicator"`). The status bar is never a picture of a real OS: a clock and generic
  cellular, Wi-Fi and battery marks (`data-status` with a `data-level`) drawn from a fixed state (9:41,
  four bars, Wi-Fi on, full battery). In the interactive page the runtime rewrites every clock from
  the browser's local time in the same `h:mm` 12-hour form, re-armed at each minute boundary. An iPhone with an island centres the clock and the marks in the
  ears beside it; Android puts them at the start and end. Its content is light or dark: `window.statusBar`
  `light` or `dark` picks it, and `auto` or none takes whichever of white or black contrasts more with the
  app's top colour. The top colour comes from geometry, not from reading CSS properties one by one: a
  small layout pass places the window's content on the screen (flex lines with growth and shrink, gaps, arrangement
  and alignment, a reversed line placed from its end, one-cell boxes, collection grids' column tracks, block flow, minimum and maximum sizes, aspect ratio, padding including
  the safe-area insets, absolute insets, relative offsets and translations, overflow clips, corner radii, and CSS paint
  order with z-index), then samples evenly spaced points along the screen's top edge. A point in a rounded
  corner's cut-away region is outside the box: neither its background nor its overflow clip's descendants
  paint there, so a circle meets the top edge at one point. Logical corners follow the element's
  direction, so right to left rounds the opposite side. A box of unmeasured height keeps square
  corners, because its real height could scale the radii down. At each point the
  last opaque background painted there is the colour, else the screen background; the colour at the most
  points wins. Element opacity multiplies down the tree, so a background counts only when it is opaque
  after that opacity, and a fully transparent subtree paints nothing. The window placement is part of the
  layout, so a bottom sheet or floating window leaves the screen background at the top edge. Text and
  other unsized content are not measured: an unknown height or offset is taken as non-zero, a content-sized
  width covers nothing, a flex item whose automatic minimum depends on that content does not shrink, and a box, row or column child with no self-alignment starts at its container's
  start as the renderer emits it. A subtree that starts below the top edge inside an overflow clip, or
  behind a transform other than a translation, is not laid out. Landscape swaps the screen size, uses
  the landscape safe areas, and moves the cutout from the top edge to the left edge. A frame whose
  landscape top inset is 0 (an iPhone) draws no status bar in landscape. `safeAreaPadding` adds the inset on each named edge to the node's padding; like
  `windowInsetsPadding`, an edge an ancestor already applied adds nothing more, and an inset adds to a component's own
  padding on that edge (`ime` adds nothing,
  since the still has no keyboard). Safe areas are exposed as
  `--safe-top`, `--safe-bottom`, `--safe-left` and `--safe-right`. Both devices draw a
  window's content edge to edge and a top app bar takes no inset of its own, so it clears the
  status bar only through `safeAreaPadding`; likewise content clears the landscape cutout side
  (an iPhone's 59 pt left inset) only through `safeAreaPadding` on the `start` edge.
- **Determinism.** Serialization writes attributes and style properties in sorted order, so the
  same input renders the same bytes. Event-handler attributes are rejected.

## Device frame registry

`src/features/prototype/web/deviceFrames.json` is data only: adding a device is one entry, with
no code change. `deviceFrameSchema.ts` holds its strict schema, and the registry's unit test
validates every entry, so an invalid entry fails CI instead of rendering wrong geometry. The
registry is not validated at load: `deviceFrames.ts` stays free of zod so the still renderer
bundles for the browser (see [Prototype web library](prototype-web-library.md)), and fills the
schema's defaults and `inner` panel itself; a unit test holds that result equal to the schema's
parse.

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
  emulator or simulator say so, and replacing them with measured values is a data change. Sources
  live in `deviceFrameSources.json`, keyed by frame id, because only the schema test reads them;
  the renderer imports `deviceFrames.json`, so provenance stays out of the browser bundle. The
  test validates each entry with its source merged back in, and rejects a frame without a source
  or a source naming no frame.

Beyond the schema, a registry is invalid when two entries share an id, a cutout lies outside the
portrait screen, or a safe area leaves no screen in either orientation.

When a request names no frame, the default is `pixel-9` for Android and `iphone-16` for iOS. An
unknown frame id is an error that lists the valid ids.
