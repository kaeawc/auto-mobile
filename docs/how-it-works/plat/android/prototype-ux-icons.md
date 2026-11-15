# Icons and images

Part of [the agent-authored prototype specification](prototype-ux.md).

Built-in names are a curated set of 300 Material icons in snake_case (`home`, `alarm_add`); the
sorted source is `schemas/prototype-icon-names.json`, which generates the `iconName` definition in
`schemas/prototype-spec-contract.json` shared by all validators. CtrlProxy's generated R8 rules
retain only those names in all five styles from `material-icons-extended`. An icon
node may set `variant` (`filled` default, `outlined`, `rounded`, `sharp`, `twoTone`); nav items are always
filled. Material Symbols names without a counterpart and symbol `weight` / `fill` axes (which need a bundled
variable font) are unavailable. Custom text fonts ship as host-uploaded assets (see "Custom fonts").

Unknown names reject the spec at the offending field with close substring suggestions and an allowed-icon lookup URI. Images are ID-based (#9301): `{type: "image", asset: "opaque-id"}` and nav
`image: "opaque-id"`. Existence is not validated at spec level; a missing asset renders a placeholder and is
reported in `missingAssets`. Bytes, MIME types, URLs, cache paths and screenshot handles are not spec
properties.

## Asset transport (#9301)

`put_prototype_asset {id, mimeType, dataBase64}` uploads one asset and
`remove_prototype_asset {id}` deletes one; each gets one `prototype_result` carrying the
request ID. Bytes travel as base64 in the single JSON text frame, like screenshots.
Heap, not the 64 MiB frame limit, is the binding constraint, so the caps are conservative. The
host shares them through `schemas/prototype-asset-contract.json`:

- 4 MiB per asset, 32 assets, 16 MiB total, and ids of 1 to 256 characters;
- `image/png`, `image/jpeg` or `image/webp` (exact lowercase) whose bytes must start with the
  matching signature;
- `font/ttf` and `font/otf` (2 MiB each, see Custom fonts).

Putting an existing ID replaces it; a full store rejects the put with a clear error and never
evicts. Removing an unknown ID succeeds. Assets sit in the CtrlProxy cache directory. The runtime
clears them when the prototype session ends: on any dismissal, on service start, unbind or
teardown, on `dismiss_prototype` with `all`, and when the last client disconnects (even with no
prototype showing). A show replacement and a temporary lock-screen hide keep them.

## Custom shader assets

`application/vnd.automobile.agsl` assets carry UTF-8 AGSL source, capped at `MAX_PROTOTYPE_SHADER_ASSET_BYTES = 16384`. Upload a local `.agsl` file through `assets: [{id, path}]`, then reference its id with `style.shader: {asset, uniforms?}` (also accepted in `styleWhen`). The host refuses uploads and shader specs unless `AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1`; the Android runtime must advertise `prototype_custom_shaders_v1`. Shader assets share the existing count and total-byte limits. Available assets must have the AGSL MIME type and every supplied uniform must be declared as a scalar float in that source. iOS (including simulator saves) and ProtoViewer bundles refuse custom shaders. Native host export refuses shader specs on both platforms until the generated hosts support shader assets.

Source rules: valid UTF-8 with no leading BOM; the scanner strips comments (`//` and `/* */`) to
separators before token scanning; code tokens are ASCII. A source declares at most 16 scalar
`uniform float name;` uniforms plus one optional `uniform shader content;` (a shader may sample
only the node's own rendered content). Validators refuse preprocessor directives, strings,
escapes, qualifiers, arrays, initializers, comma declarations, duplicate names and other uniform
types or samplers. Reserved uniform names are `content`, `main`, GLSL/AGSL reserved words and
names starting with `sk_` or `gl_`. The `style.shader.uniforms` object supplies at most 16
declared float names matching `[A-Za-z_][A-Za-z0-9_]*`, with finite values in
[-1000000, 1000000]. `AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS` is off by default.

The Android runtime advertises `prototype_custom_shaders_v1` only on API 33+. It compiles on `put_prototype_asset` before writing any source; unsupported APIs return a typed refusal naming API 33, and invalid source returns the compiler message capped at 2048 UTF-8 bytes without splitting a character. Failed replacements preserve the previous asset. Validation runs in three stages:

- Device lexical preflight restricts inputs to scalar floats and the node's own `content`.
- Show/patch validation checks every style alternative and hidden descendant against device-compiled scalar declarations.
- Per-node compilation rechecks all supplied names before setting any values, clamps finite values to [-1000000, 1000000], and gives each node an independent shader instance.

Procedural sources without a content declaration receive an unused `uniform shader content;` so the same RenderEffect path can bind the node's content.

Embedded applications supply AGSL bytes through `PrototypeAssets.withShaders` and its optional shader resolver; image and shader lookups use separate typed namespaces even when ids collide. These sources receive the same lexical, UTF-8 and compiler validation before rendering. Each composed node owns its compiled shader, reused across uniform changes and recompiled when its source asset or version changes. Removed float uniforms reset to zero. Compiler diagnostics refer to authored source lines, accounting for the injected content declaration. Each node applies its shader through a clipped Compose graphics layer using `createRuntimeShaderEffect(shader, "content")`. Content remains unshaded while preparation runs, while an asset is missing/unreadable, or on API levels below 33. Missing shader assets follow the existing missingAssets warning/re-upload path and retry on asset changes.

One session-level frame-clock loop runs only while at least one visible shaded node is composed (excluding settled-hidden retained subtrees) and the prototype lifecycle is RESUMED. The control-proxy pauses that lifecycle while hiding its window for capture. Only the newest composed window root owns sampling during a window replacement; retiring an older root cannot hide or pause the new one, and a failed replacement restores the older root. Gaps discard the first interval after resuming without clearing budget evidence.

The runtime permanently disables all shaders in the prototype after 8 consecutive intervals strictly above 24 ms, or more than 30 slow intervals in the last 60 sampled intervals. Intervals at or below 24 ms reset only the consecutive streak; the loop ignores duplicate/backwards timestamps. Status lists this once as `frame budget exceeded while shaders were active`: it measures whole frame intervals and cannot attribute the delay to a shader. The loop cannot measure a static expensive shader without fresh frame work, and cannot catch asynchronous RenderThread/GPU faults.

Synchronous compile/effect/draw exceptions disable only the affected composition instance. Duplicate repeat identities have separate guards; disposed registrations are evicted. The `get_prototype_status` result reports at most 64 node failures with unique instance ids and bounded reasons, plus a `+N more` summary, in optional `shaderFailures`. Host `inspect` adopts these into the next host-local `status`. An in-place show preserves the session budget and recorded failures; dismissal or an explicit reset starts a new lifetime. A remounted node gets a fresh instance guard, while a tripped session budget continues to disable all shaders.

The wire protocol has no host opt-in channel. The existing host gate `AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1` therefore remains the authorization boundary; capability advertisement alone does not enable the host to send shaders. Direct device clients are responsible for the same opt-in policy.

## Device media items (#14192)

Which camera, media-library, scanner and microphone routes work on each emulator, simulator and
device, and how to seed them, is in the [camera and media guide](../../prototype-camera-media.md).

Camera, picker and recorder producers write a media item (or an array of them) to an `into`
pointer in `/data`, under the rules of `applyPrototypeDataWrite` and with no nulls. The device
mints its ids with the reserved `media:` prefix and keeps the bytes in its own store, so an `image`
can show something the device produced:

```json
{
  "asset": "media:5b1f…",
  "kind": "image",
  "mimeType": "image/jpeg",
  "width": 3024,
  "height": 4032,
  "bytes": 2481152,
  "source": "camera",
  "createdAt": "2026-10-21T10:00:00Z",
  "thumbnail": "media:5b1f…/thumb"
}
```

`kind` is `image`, `video` or `audio` (`durationMs` for the last two); `source` is `camera`,
`library`, `microphone` or `injected`; `thumbnail` is a JPEG of at most 512 px.

- **`imageAsset` gains `{data: "/pointer"}`**, a pointer into `/data` that resolves to a media id,
  on an `image` `asset` and on a tab or bottom-nav item `image`. It is exactly one key, a pointer
  string. A repeat placeholder also binds in a string `asset` (`"asset": "{item.thumbnail}"`), so a
  gallery is a `grid` plus `repeat` over `/data/picked`.
- **`media:` is reserved.** Host `put_prototype_asset`, `show.assets`, bundles and saved layouts
  refuse an asset id that starts with it, and a `media:` id is never listed in `missingAssets`
  (an unknown or deleted one draws the broken-image placeholder).
- **No image budget.** A `{data}` slot names no uploaded asset and costs 0 against
  `MAX_PROTOTYPE_IMAGES` (an `image` node still counts 1).
- **Limits** in the contract: `MAX_PROTOTYPE_MEDIA_ITEMS` 64, `MAX_PROTOTYPE_MEDIA_TOTAL_BYTES`
  512 MiB, and per item 32 MiB for an image, 256 MiB for a video and 32 MiB for audio.
- **Capability.** `prototype_platform_media_items_v1` gates `imageAsset.data`. It is a spec-language
  gate, not a platform module, so it needs no `requires.platform` entry. The validators, gate and
  shared corpus (`media-*` fixtures) exist. Device stores, EXIF handling, the read-only
  `prototype {action: "media"}` host action and the `mediaItems.inject` simulation do not, so no
  renderer advertises it and the host refuses a show that uses it.

## Rendering assets (#9301)

An `image` node draws its asset with `contentScale`: `fit` letterboxes, `crop` fills the box and clips, `fill` stretches. Bytes are decoded off the main thread with `BitmapFactory` and `inSampleSize`, downsampled to the node's laid-out size (screen size when an axis wraps) and never above 4 Mi pixels. The decoded-bitmap cache keys on asset id and a power-of-two size bucket and evicts least recently used first. It holds at most 32 MiB of decoded pixels (a larger single bitmap is drawn but not retained). A replaced, removed or cleared asset drops its decoded copies immediately and showing nodes reload; uploading a previously missing id fills the placeholder.

A nav item draws its `image` when ready, then its built-in `icon`, then a gray square. While an image decodes the node shows a plain gray box. A gray box with a broken-image glyph marks an unknown id, undecodable bytes, or a file the OS evicted from the cache directory (the store lists it but `read` returns null).

`show_prototype` lists referenced ids the device has no copy of in `prototype_result.missingAssets`, in first-use order. It is a warning: `success` stays true and placeholders show, so the host can upload and the nodes fill in without another `show`. The field is omitted when nothing is missing and from every other result. An id the store lists but whose file was evicted is not reported at `show`; it renders the placeholder.

Host surface: the `prototype` tool's `show` takes
`assets: [{id, path}]`, an absolute daemon-readable file path per asset. The host
reads and validates every file first (signature-detected MIME type, the contract
limits, unique ids), then uploads sequentially before the prototype request. Any
failure fails the call before the prototype changes and names the assets already
stored.

An entry may instead be `{id, observation}`, an
`automobile:observation/{deviceId}/{observationId}/screenshot` URI. The host reads it
through the same handler as that resource (current-observation check, pending-capture
wait, retention lease). Any client can read that resource, so no access is widened.

Sometimes `prototype_result.missingAssets` lists an id the same call uploaded, because the device
cleared its store between the upload and the show. The host then re-uploads those assets
once from the bytes it already holds and re-sends the show once. It never
loops: if they are still missing, or the retry fails or is cancelled, the first
successful result is returned with `missingAssets` and a `warning` on the tool output.
Ids the call did not supply are only reported. See `docs/tools.md` for the result and
deadline model.

## Custom fonts (#10443)

`style.fontFamily` also accepts `{asset: "<id>"}`, an opaque id of a font uploaded through
the same asset pipeline as images (`put_prototype_asset`, or `assets: [{id, path}]` on the
host). The spec carries only the id; font bytes, MIME types and caps stay out of it.

- Transport: `font/ttf` and `font/otf` join the contract's MIME types. The bytes must start
  with an sfnt version tag, `0x00010000`, `true` or `OTTO`, accepted for either MIME type
  because an OpenType file may carry TrueType outlines. TrueType collections (`ttcf`) and
  WOFF are rejected. Fonts are never decoded as images. The per-font cap is 2 MiB
  (`MAX_PROTOTYPE_FONT_ASSET_BYTES`); fonts count toward the 32-asset and 16 MiB totals
  like images. The host detects a font from the file signature, not the extension.
- Missing assets: `prototype_result.missingAssets` lists a referenced font the device has no copy
  of, with the image ids (references in `style` and `styleWhen` count, including hidden nodes).
  The text draws in the default family until the font is uploaded.
- Rendering: the runtime loads the font from the stored asset file with `FontFamily(Font(file))`,
  once per asset, and caches it. A file that cannot be parsed logs one warning and draws
  with the default family; the font never fails the prototype. Replacing an asset reloads
  it; removing it (or ending the session) while a spec still references it falls back to
  the default family, the same as a removed image becoming a placeholder.
- Weights: one file is one face, so `fontWeight` selects that face rather than a bolder
  one. Upload a font file per weight and use `styleWhen` to choose between them.
