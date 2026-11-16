# Prototype web renderer

The web renderer draws a prototype inside a device frame as one self-contained HTML page. This
document covers the per-prototype resources (the page, the embed envelope and the single-file
Compose and SwiftUI sources), spec revisions, the page, its browser check, the still renderer and the device frame
registry.

The renderer is described across these pages:

- [Browser, Android and iOS parity checks](prototype-web-renderer-checks.md)
- [Still renderer](prototype-web-renderer-still.md)
- [Still renderer coverage](prototype-web-renderer-coverage.md)
- [Still renderer coverage of overlays, media and pickers](prototype-web-renderer-coverage-2.md)
- [Skins, frames and the device frame registry](prototype-web-renderer-frames.md)

## Resource

`automobile:prototype/{id}/web{?frame,revision,variant,mcpSessionId}` (`text/html`) is registered in
`src/server/prototypeResources.ts` and read by `readPrototypeWebResource` in
`src/features/prototype/web/prototypeWebResource.ts`.

- **Variants.** The page's variants are the ids whose latest revision carries the same
  `variant.group` as `{id}`'s, in first-seen order, labelled by `variant.label`. An id without a
  group is the only variant, labelled by its id. The `variant` parameter (default `{id}`) picks the one shown
  first and must be in that set.
- **Revision and frame.** `revision` (default the latest) is a kept revision of the variant shown
  first. `frame` defaults to `defaultDeviceFrameId` of the platform that showed that revision, else
  `pixel-9`.
- **Errors.** An unknown id lists the known ids; an evicted revision names the oldest kept; an
  unknown revision lists the kept ones; an unknown frame or variant lists the valid ones. All are
  `ActionableError`s.
- **Session filter.** `mcpSessionId` narrows the lookup to the revisions that MCP session produced
  (`PrototypeSpecRevisionFilter`). The default revision is that session's latest, and `revisions`
  lists only its own. A revision of another session, or a session with none kept, is an
  `ActionableError`. The page's inlined history is not filtered, so variants without a revision
  from that session still render.
- **Read result.** `_meta` is `{revision, deviceRevision?, mcpSessionId?, revisions, variants,
  frame, sha256, rendererVersion}`; `mcpSessionId` is the producing session of the revision shown
  first and `rendererVersion` is the server release version.
- **Embed envelope.** `automobile:prototype/{id}/embed{?revision,variant,mcpSessionId}` (`application/json`) is
  read by `readPrototypeEmbedResource` in `src/features/prototype/web/prototypeEmbedResource.ts`.
  Its text is `{format: "automobile-prototype-embed", version: 1, requires, spec}`. The `spec` is
  the stored spec of the variant and revision the web page would show first. This host computes `requires` as
  `requiredPrototypeCapabilities(spec)`, so the web library can refuse a spec
  it cannot draw whole ([Prototype web library](prototype-web-library.md)). Variant, revision, the session
  filter and errors are the web resource's; there is no `frame`. Its `_meta` is the web resource's without
  `frame`, its `sha256` hashing the envelope text.
- **Embed glyphs.** When any glyph the spec names resolves, the envelope
  carries `glyphs` (additive within version 1) and, when any has no glyph, `iconMissing`, built by
  `prototypeEmbedGlyphs` from the same `PrototypeIconGlyphSource` as the still. The builder
  collects the keys statically from the contract over the component-expanded spec, not from a render. They cover
  every `iconName` slot in its object's `iconVariant` (else `filled`). They also cover the glyphs a control draws with no
  `iconName` slot: filter chip and segment checks, the select arrow, the date picker's month arrows. Every iconName-valid string
  in `state` or `data` adds a key in `filled` and in each variant an icon node uses, because a state change can hand that name
  to any icon. A
  value is the allow-listed shapes as SVG markup. Both skins draw these Material glyphs (#16526).
- **Single-file formats.** `automobile:prototype/{id}/compose{?frame,revision,mcpSessionId}` (`text/x-kotlin`)
  and `automobile:prototype/{id}/swiftui{?frame,revision,mcpSessionId}` (`text/x-swift`) are read by
  `readPrototypeSourceResource` in `src/features/prototype/prototypeSourceResource.ts`. They render
  the `automobile:prototype/native` host file (`nativePrototypeTemplates.ts`) with an `inline`
  input. It holds the spec JSON as a string constant; Kotlin splits it into joined literals of at most
  16 384 characters to stay under the JVM's 65 535-byte constant limit. It also holds a header comment naming
  the URI, revision, frame, library coordinate and required capabilities. Per referenced asset it names
  its bundle path and `automobile:prototype/native/asset?id=…&assetId=…` URI (assets are never
  inlined). Last comes a preview sized to the frame's screen (`@Preview(widthDp, heightDp)`, `#Preview`
  with `.frame`). The native resource's output is unchanged without `inline`. Revision and errors
  follow the web resource. The `frame` parameter defaults to `defaultDeviceFrameId` of the format's platform
  (`pixel-9`, `iphone-16`), since the format fixes the platform. The shader and Swift-equivalent
  asset id refusals are the native resource's. Its `_meta` is `{revision, deviceRevision?, mcpSessionId?,
  revisions, frame, sha256, rendererVersion}`.
- **Listing.** Each known id gets concrete resources
  `automobile:prototype/{id}/{web,embed,compose,swiftui}` named `prototype-{id}-{format}`, titled
  `{id} (web)`, `{id} (embed)`, `{id} (Compose)` and `{id} (SwiftUI)`.
  The server registers them when the id's first revision appears and unregisters them when the id is evicted. Each change
  sends `list_changed`. List entries carry no
  `size`, `annotations` or `_meta`, because the registry's entries do not; the read result carries
  `_meta`.
- **Updates.** Every new revision, and every byte-cap pruning of another id's history, sends
  `resources/updated` for the parameter-free URI of every format of the id. It also covers the web and embed
  URIs of each id in its variant group and of each id in the group it left (or was evicted from), in
  revision order. The concrete resource matches subscriptions
  exactly, so a subscription with any query (`?revision=N`, `?frame=…`) is never notified.

## Spec revisions

`PrototypeSpecRevisions` (`src/features/prototype/prototypeSpecRevisions.ts`) is fed by
`PrototypeShownSpecs`, so a revision exists exactly when the shown-spec mirror accepts a spec:

- `endShow` storing a spec records a `show`; refused, superseded and poisoned shows, and shows the
  mirror leaves untracked (persisted `/data`), record nothing. `commitPatch` committing records a
  `patch` with the reply's `revision` as `deviceRevision`. Device data writes record nothing.
- Every MCP connection on the daemon shares the store, so each revision keeps the connection
  that produced it as `mcpSessionId`. That is `currentConnectionMcpSessionId()` at the prototype tool call,
  the identity autolock and ownership already use. A call with no connection records none. The
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

- **Views.** The page pre-renders every inlined revision of every variant in each orientation the frame
  has (portrait and landscape; portrait only for a watch; landscape only for a TV or car). It also renders
  every posture of a foldable frame (such views carry `data-posture`). When the outermost stack an orientation
  and posture draws has more than one screen, it renders once per screen of that stack.
  Screens go start first, then the others in key order, and such views carry `data-screen`. This is needed since a
  `visibleWhen` can show a different stack in each.
- **First view.** The first view is the chosen variant's chosen
  revision (default: latest) in the frame's first orientation (`data-orientation` on `body`). It uses
  the frame's default posture and its start screen; the rest are `hidden`. The budget keeps or
  drops views by screen index: every orientation and posture's start together, then each one's next
  screen together. Every view renders in the input's `locale` and `textSize`, passed to the still.
- **Controls.** Only seven. Rotate switches portrait/landscape; it is absent for watch, TV and car frames, which
  have one orientation. A layout posture select (`layout-posture`) appears only for a frame with postures,
  in registry order; switching shows that posture's views and fits the new view. Zoom and pan offer
  fit, 50–400 %, wheel, drag and double-click to fit. The opt-in 3D view
  ([Prototype web 3D device view](prototype-web-3d.md)) has posture and hinge controls only for a frame
  with a hinge and postures. A variant select appears only with more than one variant. A screen select appears only
  when some revision in the page has more than one screen view. The revision history (newest
  first, `r<N> · show|patch`) appears only when some variant has more than one revision in the page.
- **Screen select.** The
  screen select lists the shown revision's own screen views and is hidden with fewer than two, so
  it never offers a view the page lacks. Switching variant or revision keeps the chosen screen
  when the new revision has it, else shows that revision's start. Rotating or changing posture
  relists the shown view's own screens. Controls are buttons and a select with labels. A toolbar note says the preview is
  static: taps do nothing, and the controls switch pre-rendered views. Below 720 px wide the
  history sits under the stage, so the stage keeps the width.
- **Script.** `prototypeWebPageRuntime`, then `prototypeWeb3dRuntime`, are inlined from their
  `toString()` into the one pinned script, so each must stay self-contained. It only shows and hides views, lists the shown revision's screens in the
  screen select, moves the stage and animates rotation. UI state stays in memory, with no storage, cookies or URL
  changes. It must stay at or below 150 KB.
- **Rotation.** Rotate turns the frame 90° (counterclockwise into landscape, clockwise back)
  with the Web Animations API. The outgoing view turns away from upright while the incoming view,
  pre-rendered in the new orientation, turns in from a quarter turn. Both track one frame, and
  the stage's fitted scale animates with them. Android (`data-platform` on `body`) cross-fades
  the content over a 500 ms turn. The iOS frame hands over to the new layout in the first quarter of a
  400 ms turn, as its window re-lays out while the bounds animate. The end state is the plain
  landscape view. A second rotate finishes the running turn first. The `prefers-reduced-motion:
  reduce` setting skips the animation.
- **No network.** The CSP is `default-src 'none'`, the script pinned by its SHA-256, inline
  styles, and `data:` images and fonts. The page references no external URL, and declares an
  empty `data:` icon so no browser requests `/favicon.ico` against that CSP.
- **Budget.** The page is at most 2 MiB. The build always keeps the start screen of each variant's latest revision and
  of the revision shown first, then their other screens while they fit. It adds older
  revisions newest first while their start screen and history entry fit, each followed
  by its other screens while they fit. It measures the shell (head, toolbar with every screen of the shown
  revision, full history list and script) first. If the kept start screens alone do
  not fit, the build fails with an `ActionableError` naming the largest view.
- **Images.** `buildPrototypeWebPageWithImages` (`webImageEncoding.ts`) builds the page once to
  learn every bound asset an `image` draws and its boxes. It reads each asset's bytes from a
  `PrototypeWebAssetSource` and re-encodes it with sharp (`loadSharp`) to WebP quality 80 at the
  largest size the frame draws it. It then builds again with the encoded images. An iOS frame applies
  the EXIF orientation first, as `UIImage(data:)` does; an Android frame keeps the stored pixels,
  as `BitmapFactory` ignores the tag.
- **Image boxes.** A box is the frame
  density times the node's fixed dp size. The `crop` and `fill` modes must cover their fixed axes. When
  one axis is fixed, they also cover their `fill` axes at the screen's long side (the landscape width). The `fit` mode and
  other unfixed axes fit inside the long side; the image is never enlarged. When the encoded
  images do not all fit the budget, the build re-encodes assets with such a `fill` axis, bounding it
  by the screen's short side (the portrait width). The page then keeps the longest prefix of images,
  in budget order, at their long-side encodes that still inlines as many images as all-compact
  encodes would.
- **Natural size.** An `image` that wraps both axes, with no weight or authored `aspectRatio`, draws
  at its natural size in points: the source's oriented pixel size, before any downscale, on every
  frame and density (as iOS draws `UIImage(data:)`). Its height follows the aspect ratio, and
  authored minimums and maximums still bound it.
- **Image fallbacks.** The build skips a missing, non-image
  or undecodable asset (logged). It reports one whose data URI alone exceeds the page as
  `assetOverBudget`. The encoded data URIs are capped cumulatively, in budget order, at
  `maxImageBytes` (default: the page budget): the first image past the cap and every later one
  stay placeholders reported `assetOverBudget`, and the later ones are never encoded. The page
  budget decides which of the rest fit. An image draws more markup than a placeholder. When the
  second build's always-kept views no longer fit, the first build stands, its images reported
  `assetOverBudget`. The resource reads assets from the host asset cache of each device currently
  showing one of the variants (Android and iOS cache their uploads); without one, images stay placeholders.
  Asset ids are chosen per device and the page holds one image per id, so an id two of those
  devices cached with different bytes stays a placeholder.
  It snapshots the shown variant's revisions before encoding, so a revision landing meanwhile does
  not change the page's `_meta`.
- **Image budget.** Each image is one `:root` rule in the head defining `--pa-<slot>` (its
  `data:image/webp` URI), `-bg` (transparent), `-ar` (its aspect ratio), `-w` (its natural width)
  and `-on` (1). Views only
  reference the slot, so view bytes do not depend on which images fit and every orientation and
  revision shares one copy. A rule is charged once, in this order: the images of the shown
  revision's start screen, then of the other pinned start screens, then each screen's images right
  after that screen is kept. Within one build an image that does not fit is never retried and
  draws its placeholder; it is reported `assetOverBudget`, and one with no bytes `assetNotInlined`.
- **Determinism.** The same input yields byte-identical HTML.
