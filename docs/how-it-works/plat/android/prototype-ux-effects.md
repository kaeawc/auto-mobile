# Prototype spec: effects, maps, web content and charts

Part of [the agent-authored prototype specification](prototype-ux.md).

## Effects (#15128, #15129, `prototype_effects_v1`)

`style.effects` is an array of 1-4 effects drawn in order. The list is closed and data-only: a
`source` key, `type: "shader"`, a fifth effect, an unknown type and an out-of-range param are each
rejected at the offending path, identically in the TS, Kotlin and Swift validators (so the spec's
opening rule, no code, holds). `schemas/prototype-spec-contract.json` (`definitions.effect`) is the
source of truth; the shared corpus pins it.

| `type`                | Params (all optional unless marked)                                                | Android floor |
| --------------------- | ---------------------------------------------------------------------------------- | ------------- |
| `noise`               | `amount` 0-1, `grain` 0.5-8 dp, `seed` int 0-65535, `monochrome`                   | 33            |
| `gradientMesh`        | `colors` exactly 4 (required; hex, role or `{light, dark}`), `softness` 0-1        | 33            |
| `shimmer`             | `color`, `angle` -360..360 degrees, `width` 0.05-1 of the node                     | any           |
| `glow`                | `color` (required), `radius` 0-48 dp, `intensity` 0-1                              | any           |
| `vignette`            | `color`, `intensity` 0-1, `radius` 0-1                                             | any           |
| `blur`                | `radius` 0-25 dp (required); blurs the node's own content                          | 31            |
| `pixelate`            | `cell` 1-64 dp (required)                                                          | 33            |
| `chromaticAberration` | `offset` 0-8 dp, `angle` -360..360 degrees                                         | 33            |
| `wave`                | `amplitude` 0-16 dp, `wavelength` 8-400 dp, `angle` -360..360 degrees              | 33            |
| `ripple`              | `amplitude` 0-16 dp, `wavelength` 8-400 dp, `center` `{x, y}` each 0-1 of the node | 33            |

Every effect also takes `animate: {periodMs}` (integer 400-20000; a loop, separate from the
node-level motion-v2 `animate`) and `phase` 0-1.

- **Paint only.** Effects never change layout, hit testing, observe bounds, accessibility
  semantics, the host dismiss controls or the host accessibility dismiss action, and never draw
  outside the node's bounds (the authored viewport for the root).
- **Frozen phase.** Under `motion: "none"`, animator scale 0, Reduce Motion (iOS) and while the
  prototype is hidden, an animated effect stays at its `phase` so screenshots are deterministic.
  `noise` is seeded and never uses device randomness.
- **`styleWhen`** replaces `effects` as a whole when it matches.
- **Limits.** `MAX_PROTOTYPE_EFFECTS` (64) and `MAX_PROTOTYPE_ANIMATED_EFFECTS` (8) count over the
  expanded `repeat` tree. Counting is conservative: every declared list counts, `styleWhen` styles
  included, although only one list applies at a time. A list longer than 4 is reported at
  `<path>.style.effects` before the count is applied. The node that crosses a limit is reported
  (`Effect limit exceeded`, `Animated effect limit exceeded`); a template inside a `repeat` is
  reported at the `repeat` with the `Expanded` forms of those two messages.
- **Capability.** Any `effects` list needs `prototype_effects_v1`, checked on `show` and on the full
  patch result. CtrlProxy, the embedded renderer and the iOS agent (#15130) advertise it; the host
  refuses `effects` for a device that does not.

### Android rendering (#15129)

Compose plus bundled AGSL, in `android/prototype-compose` (`PrototypeEffects*.kt`); the same module
renders in CtrlProxy and ProtoViewer. No spec carries shader source: the AGSL programs are constants
in `PrototypeEffectShaders`.

- **Layers.** Distortions (`blur`, `pixelate`, `chromaticAberration`, `wave`, `ripple`) are one
  chained layer `RenderEffect` around the node's background and content, in authored order, clipped
  to the node's bounds. `gradientMesh` paints between the background and the content. `shimmer`,
  `glow`, `vignette` and `noise` paint over the content, clipped to the node's shape, undistorted.
  Effects sit inside the node, so the host dismiss controls and the node's observe bounds are untouched.
  A node with a distortion clips anything that overflows its bounds, as the effect itself must not.
- **API floors and fallback.** Brush-based looks (`shimmer`, `glow`, `vignette`) draw on any API,
  `blur` needs 31, the AGSL ones 33. Below its floor an effect is omitted and the node renders
  unshaded. The device reports every omitted effect as `degradedEffects: [{path, type, reason:
  "api"}]` on the show result and on `inspect_prototypes` (omitted when empty; older hosts see the
  same frame). `path` is the node's render identity (the `root.child...` key the renderer and
  `observe` use) plus the authored effect index, `<identity>.style.effects[<i>]`, and follows the
  `styleWhen` style in force when the reply is built. `reason: "budget"` entries use the same form.
- **Settled by the renderer (conservative choices).**
  - `phase` and `animate` move only `shimmer`, `wave` and `ripple`; `noise`, `gradientMesh`,
    `glow`, `vignette`, `blur`, `pixelate` and `chromaticAberration` are static looks and ignore
    both (they still count against the limits).
  - Colours resolve like `style.color`: hex keeps its own alpha, a role comes from the active
    scheme, a `{light, dark}` pair picks the shown mode; `scrim` is its plain scheme colour.
  - A `shimmer` band never exceeds 0.5 alpha; with no colour it is white at 0.35. `glow` is an
    inward edge glow (it never leaves the node), `vignette` defaults to black.
  - Defaults when omitted: `noise` amount 0.1, grain 1 dp, seed 0, monochrome; `gradientMesh`
    softness 0.5; `shimmer` angle 20, width 0.3; `glow` radius 12 dp, intensity 0.6; `vignette`
    intensity 0.4, radius 0.7; `chromaticAberration` offset 2 dp; `wave` and `ripple` amplitude 4 dp,
    wavelength 48 dp, `ripple` centre `{0.5, 0.5}`.
- **Time.** An animated effect reads one per-node frame clock (`withFrameNanos`). It does not
  advance under `motion: "none"`, animator duration scale 0, while the window is not shown, or in
  direct `PrototypeSpecContent` callers (previews and screenshots), so those keep the authored
  `phase`. `noise` is seeded from `seed` alone.
- **Frame budget.** If a node's frame interval stays above 32 ms for 30 frames in a row the node
  freezes its phase and `inspect_prototypes` lists its animated effects with reason `budget`. The
  guard times the window's frames, not the effect's own cost, so a slow GPU (the `-gpu swiftshader`
  CI emulators) freezes animated effects; the entry clears when a patch or show replaces the node.
  No `prototype_event` reports it: a frozen effect shows on the next `inspect`.
  ProtoViewer shows no note when it degrades an effect.

## Maps (#14308, design for the `map` node)

Rules for the `map` node (#14309) and its renderers (#14310, #14311):

- **Backends.** A spec never names a tile URL or SDK. An optional `backend` defaults to `auto`: MapLibre on
  Android, MapKit on iOS. Google Maps is an Android opt-in backend, offered only when the runtime holds a
  host-configured key. MapLibre on iOS stays optional, for the offline style and pixel parity.
- **Styles.** `mapStyle` is a closed list, never a URL (`style` is the shared node style). `plain` is the default: offline and deterministic (a
  background colour, an optional grid and graticule, then markers and polylines), with no network. CI and every
  screenshot test use it. `streets` draws tiles from the runtime's configured source. `satellite` is not offered.
  On iOS, MapKit always fetches Apple tiles, so `plain` there is drawn by MapLibre iOS or by an
  `MKTileOverlay` with `canReplaceMapContent` serving local tiles.
- **Tile source.** The `streets` source is configured once per runtime (ProtoViewer settings, or the daemon
  pushing configuration to a disposable app), never per spec. The public OpenStreetMap tile server is never
  used.
- **Keys.** A Google Maps or tile-provider key lives only in host configuration and reaches the runtime over
  the device channel. It is never written into a spec, a saved bundle, `inspect`, `observe`, logs or a
  ProtoViewer share; each renderer has a redaction test for this.
- **Egress.** Tile fetches count as network for ProtoViewer's switch that allows network for imported
  prototypes (#13622). With the switch off, `streets` falls back to `plain` with a visible "offline map" chip.
  Only the configured tile origin is contacted, and the runtime draws the data attribution outside spec
  control.

The `map` node (#14309, contract only: no renderer draws it and no runtime advertises
`prototype_platform_map_v1`) needs `map` in `requires.platform`:

```json
{
  "type": "map",
  "style": { "height": { "dp": 360 } },
  "camera": { "data": "/camera" },
  "markers": {
    "path": "/drivers",
    "as": "driver",
    "id": "{driver.id}",
    "lat": "{driver.lat}",
    "lng": "{driver.lng}",
    "title": "{driver.name}"
  },
  "onMarkerTap": [{ "type": "setState", "key": "selected", "value": "{driver.id}" }]
}
```

- `camera` is a literal `{lat, lng, zoom, bearing?, tilt?}` (lat -90 to 90, lng -180 to 180, zoom 0 to
  22, bearing 0 to 360, tilt 0 to 60) or `{data}`, a `/data` pointer to such an object. `fit` is `none`,
  `markers` or `route`; `mapStyle` is `plain` (default) or `streets`.
- `backend` is `auto` (default), `google` or `maplibre`. `auto` needs only `prototype_platform_map_v1`; any
  other value also needs `prototype_platform_map_<backend>_v1`, which the `map` module's `backends` table
  lists. `show`, `patch` and `replaceNode` refuse a backend whose capability the runtime does not advertise,
  at `<node>.backend`.
- `markers` draws one marker per item of the `/data` array at `path`, bound under `as`. `id`, `lat`, `lng`,
  `title` (also the accessibility label) and the optional `heading` (degrees clockwise from north) are
  templates resolved per item. `icon` is a Material icon name, or `{"asset": "<id>"}` naming an image uploaded
  in the spec's `assets`, never a URL (#16491). Given a complete uploaded-asset inventory, all three
  validators refuse an unknown id at `<node>.markers.icon.asset`, and the bundle export lists the asset with the
  spec's other images on Android and iOS. `animateMs` (0 to 2000) eases a moved marker.
  Every marker is an accessibility node with the identifier `<mapId>/marker/<id>`, so `observe` and `tapOn`
  reach it.
- `polylines` (1 to 8) each draw the `{lat, lng}` points of the `/data` array at `path`, with an optional
  `width` (1 to 16) and `color`.
- `onMarkerTap` runs with the tapped marker's item bound under `as`. `onCameraIdle.into` is a `/data/<pointer>`
  path that receives the settled camera.
- Every `emit` a marker tap runs, including those in its nested `onSuccess`, `onError` and `startTimer`
  actions, reports `markerId` (the tapped marker's resolved `id`) in its event context after the authored
  entries, under the same byte budget. The contract lists the name in
  `platformModules.map.events.markerTap.emitContext`. All three validators refuse an authored
  `context.markerId` inside `onMarkerTap`. Outside it, `markerId` is an ordinary context name.
- `showUserLocation: true` reads the `location` module, so it also needs `location` in `requires.platform`
  and the `location` permission in `requires.permissions`.
- The `map` module has no calls or state. Its events `map.markerTap` and `map.cameraIdle` exist so a
  simulation can deliver them.
- Checked when the map is drawn, not at validation: at most 500 markers and 2000 polyline points in total,
  and marker ids unique within the resolved data.

## Web content (#14312)

The `webView` node (contract only: no renderer draws it and no runtime advertises
`prototype_platform_webview_v1`) shows an https page and needs `webview` in `requires.platform`:

```json
{
  "type": "webView",
  "url": "https://example.com/post/{data:/selected/slug}",
  "allowedOrigins": ["https://example.com"],
  "navigationStateKey": "articleNav",
  "titleKey": "articleTitle",
  "canGoBackKey": "articleCanGoBack",
  "onNavigate": [{ "type": "setData", "path": "/data/lastUrl", "value": { "value": "{url}" } }],
  "onBlockedNavigation": [{ "type": "emit", "name": "openExternally" }]
}
```

- `url` is `https://` only (pattern `webViewUrl`, at most 2048 characters), with placeholders allowed after the
  literal scheme. There is no inline `html` field and no script field: a spec carries no markup or code.
- `allowedOrigins` holds 1 to 8 unique exact origins, `https://host[:port]` in lowercase with no path and no
  default `:443` (pattern `webOrigin`). Every host must be a DNS name: `localhost`, `*.localhost` and any host a
  URL parser reads as an IP address (a last label that is decimal or `0x` hexadecimal, or a bracketed IPv6
  literal) are refused. Refusing every IP literal, not only private ranges, keeps the three validators equal:
  JavaScript, the JVM and Swift disagree on numeric host spellings such as `2130706433`.
- When the URL's authority is literal, `https://<authority>` (lowercased, an explicit `:443` dropped) must be
  one of `allowedOrigins`. A templated authority is checked by the runtime once it resolves.
- The `url` binds placeholders like any text field, so its `{platform:…}` reads must be declared, and in a
  library spec it is a request sink: a secure text field's value cannot be bound into it.
- `navigationStateKey` (`loading`, `loaded`, `error` or `blocked`) and `titleKey` name declared string state;
  `canGoBackKey` names declared boolean state. All three bind component props like other node state keys, and
  every state write re-checks their types.
- A `webView` `id` uses the state-key pattern, the grammar of the `webview.*` `node` argument that names it.
- `javaScript` defaults to `false`; `true` is accepted and never comes with a bridge. Page subresources cannot
  be checked at a resolved address the way `request` is, so an imported (ProtoViewer) prototype may show a
  `webView` only while network for imported prototypes is on. Turning it off replaces the entire imported
  prototype with a refusal; turning it on restores rendering. The refusal names the first `webView` depth first
  in a fixed order (adaptive slots, a list's `header` and `footer`, `child`, `children`, then `screens` by key),
  pinned by `test/fixtures/prototype-spec/webview-import/cases.json`; an MCP `open` gets one outcome per load.
- `onNavigate` and `onBlockedNavigation` are action lists. `{type: "platform", call: "webview.back"}` and
  `webview.reload` take `args: {node}`; a literal `node` must be the id of a `webView` node ("Unknown webView").
  The `webview` module has no state; its `webview.navigate` event exists so a simulation can deliver it.
- Runtimes check every top-frame and subframe navigation against `allowedOrigins` before it starts and block
  loopback, link-local, `10.0.2.2` and the daemon ports by URL host. They never add a JavaScript bridge or user
  script (`addJavascriptInterface`, `evaluateJavascript`, `WKUserContentController.add(_:name:)`), and keep
  cookies and web storage per prototype.

## Charts (#14209)

A `chart` node draws a `line`, `area`, `bar` or `ring` chart from 1 to 4 `series`. Each series
reads the `/data` array at `path` (objects only, at most `MAX_PROTOTYPE_DATA_ARRAY_ITEMS` like any data array), taking each
point's numeric `y` member and optional `x` label member. A literal `path` must resolve to an array
when the spec is shown, and every point must be an object with a numeric `y`. A repeat-bound path is
bound per row. `yRange {min, max}` fixes the axis (max above min); otherwise it spans the values
and the goal, and bars rise from zero. `xLabels` (`none`, `ends`, `all`) draws the first series'
x labels below the plot. `goal` is a dashed reference line; a `ring` takes exactly one series and a
positive goal and draws that series' latest value against it. The capability is
`prototype_chart_v1`.

Android draws it with Compose `Canvas` and no new dependency. The render mapper reads the points
from the current `/data` on every mapping pass, so a data action, request or patch redraws it. Points
a later write broke (a non-object, a non-numeric `y`) are skipped rather than failing the frame. The
chart is one accessibility node labelled with its summary ("Line chart, Heart rate, 24 points, min
58, max 141, latest 72"; "Ring chart, Steps today, 6500 of 10000"); an authored
`contentDescription` replaces it, and `observe` reports it. The x labels are visual only. The iOS
agent advertises the capability too (#14679): it draws the same four variants with Swift Charts and
describes line, area and bar charts to VoiceOver with an `AXChartDescriptor`; its summary text is
checked against the shared `chart-variants.json` fixture.
