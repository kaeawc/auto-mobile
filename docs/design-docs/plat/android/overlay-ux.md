# Agent-authored overlay specification

This is the current, unversioned contract for #9296, child of #9295. It defines
models and validation only. Compose rendering (#9299, #9300), asset transport
(#9301), wire messages (#9298), and the MCP tool (#9302) implement this contract
later. No code, expressions, URLs, image bytes, or migration instructions are
accepted in a spec.

## Owner decisions

The 2026-10-04 decisions supersede the issue's earlier proposals:

- Envelope: `{ id, window, state?, root }`, with no `specVersion`. An older or
  newer shape is rejected rather than migrated.
- Every object is strict: unknown properties, unknown node/action types, explicit
  null for optional fields, and wrong types reject the entire spec with a path.
- Scroll supports both axes. Pager is horizontal, full-page only, with no axis.
- Navigation includes `tabBar` and author-positioned `bottomNav`, bound to a pager
  or a number state key.
- Windows are edge-to-edge. Safe-area padding is an explicit node opt-in.
- A `sheet` window and a modal `bottomSheet` node are separate concepts.
- Built-in icons come from a closed list; other artwork uses image assets.

Earlier decisions still apply: the renderer is Compose; sizes and positions use
dp; overlay opacity is a percentage; app-element anchoring is supported; observe
includes overlay nodes by default; existing tap/text tools target overlay nodes;
screenshots come from observe, with no separate screenshot tool. Focus management
belongs to the window host: accessibility set-text does not require focus, while
human keyboard input does (the later device findings in #9300 supersede the older
blanket focusability proposal).

## Envelope and limits

| Property | Type / meaning                                                    |
| -------- | ----------------------------------------------------------------- |
| `id`     | Required nonempty overlay identifier string.                      |
| `window` | Required window configuration below.                              |
| `state`  | Optional flat object of string, finite number, or boolean values. |
| `root`   | Required single node.                                             |

All numeric values are finite. State keys (including action/binding/condition
keys) match `[A-Za-z_][A-Za-z0-9_]{0,63}`. No nested state, arrays, or nulls.
Overlay IDs, pager IDs, tags, event names, and asset IDs are opaque nonempty
strings; they do not share the state-key restriction.

| Constant                         | Value            | Counting rule                                                                                      |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `MAX_OVERLAY_NODES`              | 500              | Includes root and every child/page/sheet child.                                                    |
| `MAX_OVERLAY_DEPTH`              | 24               | Root has depth 1; only node nesting counts.                                                        |
| `MAX_OVERLAY_IMAGES`             | 32               | Counts image nodes and nav item image uses, including hidden ones; repeated asset IDs count again. |
| `MAX_OVERLAY_SPEC_BYTES`         | 262144 (256 KiB) | UTF-8 bytes of raw JSON, including whitespace.                                                     |
| `MAX_OVERLAY_EMIT_PAYLOAD_BYTES` | 4096 (4 KiB)     | Conservative compact JSON byte budget for each emit payload; numbers reserve 32 bytes.             |

Navigation item `image` uses also count toward `MAX_OVERLAY_IMAGES`. Assets have
separate transport and decoded-memory limits in #9301. These spec limits keep
parsing/layout work bounded without limiting image pixel data inside this file.
Emit payload nesting has a separate `MAX_OVERLAY_EMIT_PAYLOAD_DEPTH` of 24
(root payload depth 0). To avoid different number spellings in JVM/JS decoders,
the byte budget counts each finite number as 32 bytes; strings, keys, booleans,
null, punctuation, and separators use compact JSON UTF-8 bytes. This bounds
actual compact serialized size and can conservatively reject numeric-heavy
payloads. Raw number token length and whitespace are governed by the spec-byte
limit. Nonfinite JSON numbers are rejected, including inside emit payloads.

Every onTap list has 1–32 actions; tab bars have 1–32 items; bottom navigation has
2–5 items; sheet detents have 1–8 entries.

The single structural rule source is `schemas/overlay-spec-contract.json`,
imported by TypeScript and packaged as a JVM protocol resource. TypeScript's
concrete Zod schema supplies inferred types and the final typed decode. Kotlin
uses kotlinx.serialization models with sealed discriminated hierarchies. Use
`validateOverlaySpec` / `OverlaySpecValidator.validate` as the complete entry
points: structural validation, limits, and cross-references precede typed decode.
Do not bypass them with a model decoder. Untagged dimension, detent, page-target,
and scalar unions have explicit Kotlin serializers; only arbitrary emit payloads
retain JsonElement. Validated integer model fields normalize decimal/exponent
spellings before Kotlin decoding (e.g. `100.0` and `1e2` both mean 100). The protocol module has no API-dump
plugin or API-check task; its published artifact includes the contract resource.

## Windows

`window` has required `placement` and optional integer `opacity` (0–100, default
100). Opacity applies to the entire overlay, including content and scrims.

| Placement `type` | Properties                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `fullscreen`     | Optional `scrim` color. Occupies the display and blocks app touches.                                                     |
| `sheet`          | Required `edge`: `top` or `bottom`; required positive `height` in dp. App stays touchable outside the window.            |
| `floating`       | Required `gravity` from the alignment list below; required `offset: {x, y}` in dp. Outside-window touches reach the app. |

Root fills the entire window, including behind system bars and cutouts; ordinary
style constraints apply to its content. A floating/sheet root fills that smaller
window, not the entire display. No display selection is defined here (#9308).

## Common node properties

Every node has required `type`. All other common properties are optional:

| Property          | Shape / meaning                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `id`              | Nonempty node ID; required and unique among pagers for `pager`. Other node IDs need not be unique. |
| `testTag`         | Nonempty accessibility/test selector tag.                                                          |
| `onTap`           | Nonempty ordered array of actions, run in order.                                                   |
| `style`           | Strict style object below.                                                                         |
| `visibleWhen`     | `{key, equals}`; equals is a scalar. Missing key or unequal value means hidden.                    |
| `anchor`          | Bounds or app-element anchor below.                                                                |
| `safeAreaPadding` | Explicit inset selection below.                                                                    |

Hidden and closed sheet content still counts toward all limits and references.
No arbitrary extra metadata is allowed.

## Nodes

| `type`        | Node-specific properties                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `box`         | Required `children` array, possibly empty; children stack.                                                           |
| `row`         | Required `children` array, possibly empty; horizontal layout.                                                        |
| `column`      | Required `children` array, possibly empty; vertical layout.                                                          |
| `text`        | Required `text` string, possibly empty.                                                                              |
| `image`       | Required opaque `asset` string; optional `contentScale`: `fit` (default), `crop`, `fill`.                            |
| `icon`        | Required built-in `name` below.                                                                                      |
| `spacer`      | No node-specific properties; size comes from style.                                                                  |
| `textField`   | Required `stateKey` naming an initialized string state value; optional `placeholder` string, default empty.          |
| `scroll`      | Required single `child`; optional `axis`: `vertical` (default), `horizontal`. Free scrolling, with no page snapping. |
| `pager`       | Required `id` and nonempty `children` array. Each child is one full-size page; horizontal swipe only.                |
| `tabBar`      | Required `items`; exactly one `pager` or `stateKey`; optional `scrollable` boolean, default false.                   |
| `bottomNav`   | Required 2–5 `items`; exactly one `pager` or `stateKey`. Author positions it, typically last in a column.            |
| `bottomSheet` | Required single `child`, `openWhen`, and `detents`; optional `scrim`, `dragHandle`, `dismissOnSwipe`.                |

Each nav item is `{label, icon?, image?}`. Label is nonempty; icon uses the same
closed list as icon nodes; image is an opaque asset ID. Both icon and image may
be supplied; the image takes visual precedence, with icon as fallback. This
counts as one image use, regardless of whether the icon fallback renders.

Pager binding (`pager: "variants"`) follows and sets that pager's local selected
page. `stateKey: "selected"` follows and sets an initialized nonnegative integer
state value. The selected value is clamped to the available item/page range by
the future renderer. Nav item count need not equal pager page count; authors
should match them when each item represents a page. Per-pager selection starts
at zero, is separate from the flat state map, and is changed by `setPage`.

`bottomSheet.openWhen` is `{key, equals}` with a **boolean** equals value. Its
state key may be absent (sheet closed); an existing value must be boolean. A
swipe dismissal with `dismissOnSwipe: true` writes `!equals` to that key, making
the condition false. Defaults: `dragHandle: true`, `dismissOnSwipe: true`. Setting
both false is permitted; the host's non-removable safety dismiss control remains
outside author content (#9307). Detents are unique values: positive `{dp: n}`,
`"half"`, or `"full"`. They preserve author order. Half/full refer to the overlay
window's height. Sheet node scrim applies inside that window, not beyond a
floating or sheet window's bounds. A modal sheet intercepts touches inside the
window while open; a sheet placement is only a window placement.

Text interpolation is a renderer concern: `{page}`, `{pageCount}`, and state
keys may appear in text. No expressions or interpolation parsing occurs during
validation. Pager context is the nearest enclosing pager; outside a pager those
two reserved placeholders remain literal. State keys `page` and `pageCount` are
permitted but the pager placeholders take precedence within a pager.

## Style

All properties are optional. Sizes, padding, offsets, radii, and spacing use dp,
including text size. Negative offsets/positions are allowed; sizes are
nonnegative, except text size and sheet height/detent height which must be
positive. Positive values use a minimum of 0.000001 dp.

| Property              | Accepted value                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `width`, `height`     | `"fill"`, `"wrap"`, or strict `{dp: n}`.                                                                             |
| `padding`             | Strict `{top?, bottom?, start?, end?}`, each nonnegative dp; omitted edges are zero.                                 |
| `background`, `color` | Strict hex color.                                                                                                    |
| `cornerRadius`        | Nonnegative dp.                                                                                                      |
| `border`              | `{width, color}`; nonnegative dp width.                                                                              |
| `alpha`               | Finite number 0–1; default 1. Multiplies window opacity.                                                             |
| `alignment`           | `topStart`, `topCenter`, `topEnd`, `centerStart`, `center`, `centerEnd`, `bottomStart`, `bottomCenter`, `bottomEnd`. |
| `arrangement`         | `start`, `center`, `end`, `spaceBetween`, `spaceAround`, `spaceEvenly`.                                              |
| `spacing`             | Nonnegative dp between row/column children; arrangement remains authoritative for distributed free space.            |
| `textSize`            | Positive dp.                                                                                                         |
| `fontWeight`          | Integer 100–900.                                                                                                     |
| `textAlign`           | `start`, `center`, `end`, `justify`.                                                                                 |
| `maxLines`            | Integer 1–2147483647.                                                                                                |
| `fontFamily`          | Closed system set: `default`, `sansSerif`, `serif`, `monospace`.                                                     |

Colors accept only `#RRGGBB` or `#AARRGGBB`, with case-insensitive hex digits.
No short hex, named colors, CSS functions, or separate color opacity. Style
properties that do not apply to a node have no rendering effect; their shape is
still validated. Omitted layout/text properties use Compose/system defaults.
Start/end use layout direction, including RTL.

## Icons and images

Built-in Material names (36): `home`, `search`, `settings`, `person`, `favorite`,
`add`, `close`, `check`, `arrow_back`, `arrow_forward`, `chevron_left`,
`chevron_right`, `menu`, `more_vert`, `share`, `edit`, `delete`, `info`, `warning`,
`notifications`, `star`, `shopping_cart`, `help`, `refresh`, `done`, `cancel`,
`play_arrow`, `pause`, `stop`, `mail`, `phone`, `location_on`, `calendar_today`,
`visibility`, `lock`, `logout`.

Unknown names reject the spec. #9301 pins ID-based assets, but no nested reference
shape, so image nodes use `{type: "image", asset: "opaque-id"}` and nav items
use `image: "opaque-id"`. Asset existence is not validated here. A missing asset
renders a visible placeholder and reports a result under #9301; image bytes,
MIME types, URLs, cache paths, and screenshot handles are not spec properties.

### Asset transport (#9301, first slice)

`put_overlay_asset {id, mimeType, dataBase64}` uploads one asset and
`remove_overlay_asset {id}` deletes one; each gets one `overlay_result` carrying the
request ID. Bytes travel as base64 in the single JSON text frame, like screenshots.
Heap, not the 64 MiB frame limit, is the binding constraint, so caps are
conservative and shared with the host through `schemas/overlay-asset-contract.json`:
4 MiB per asset, 32 assets, 16 MiB total, ids of 1 to 256 characters, and
`image/png`, `image/jpeg` or `image/webp` (exact lowercase) whose bytes must start
with the matching signature. Putting an existing ID replaces it; a full store rejects
the put with a clear error and never evicts. Removing an unknown ID succeeds. Assets
sit in the CtrlProxy cache directory and are cleared when the overlay session ends:
on any dismissal, on service start, unbind or teardown, on `dismiss_overlay` with
`all`, and when the last client disconnects (even with no overlay showing). A show
replacement and a temporary lock-screen hide keep them.

### Rendering assets (#9301, second slice)

An `image` node draws its asset with `contentScale`: `fit` letterboxes, `crop` fills the
box and clips, `fill` stretches. Bytes are decoded off the main thread with
`BitmapFactory` and `inSampleSize`, downsampled to the node's laid-out size (the screen
size when an axis wraps content) and never above 4 Mi pixels (16 MiB as ARGB_8888). The
decoded-bitmap cache keys on asset id and a power-of-two size bucket, evicts least
recently used first, and holds at most 32 MiB of decoded pixels; a single bitmap larger
than that is drawn but not retained. A replaced, removed or cleared asset drops its
decoded copies immediately and the nodes showing it reload; uploading an id that was
missing makes the placeholder load it.

A nav item draws its `image` when it is ready, then its built-in `icon`, then a gray
square. While an image decodes the node shows a plain gray box. An unknown asset id, a
file the OS evicted from the cache directory (the store still lists it but `read`
returns null) or undecodable bytes renders a gray box with a broken-image glyph.

`show_overlay` lists the referenced ids the device has no copy of in
`overlay_result.missingAssets`, in first-use order. It is a warning: `success` stays true
and the overlay is shown with placeholders, so the host can upload the assets and the
nodes fill in without another `show`. The field is omitted when nothing is missing and
from every other result, so older hosts see the frame they always did. An id the store
lists but whose file was evicted is not reported at `show` time; it renders the
placeholder. Dismissal clearing is unchanged.

Host surface: the `overlay` tool's `show` takes
`assets: [{id, path}]`, an absolute daemon-readable file path per asset. The host
reads and validates every file first (signature-detected MIME type, the contract
limits, unique ids), then uploads sequentially before the overlay request; any
failure fails the call before the overlay changes and names the assets already
stored. An entry may instead be `{id, observation}`, an
`automobile:observation/{deviceId}/{observationId}/screenshot` URI; the host reads it
through the same handler as that resource (current-observation check, pending-capture
wait, retention lease), which is readable by any client, so no access is widened.

When `overlay_result.missingAssets` lists an id the same call uploaded (the device
cleared its store between the upload and the show), the host re-uploads those assets
once from the bytes it already holds and re-sends the show once. It never
loops: if they are still missing, or the retry fails or is cancelled, the first
successful result is returned with `missingAssets` and a `warning` on the tool output.
Ids the call did not supply are only reported. See `docs/tools.md` for the result and
deadline model.

## Actions and state

| Action `type` | Properties                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emit`        | Required nonempty `name`; optional arbitrary JSON `payload` up to the 4 KiB conservative compact JSON budget (null and nested JSON allowed).      |
| `setPage`     | Required existing `pager` ID; required `page`: `next`, `prev`, or nonnegative integer index up to 2147483647. Renderer clamps to available pages. |
| `setState`    | Required state `key` and scalar `value`; creates or replaces a key.                                                                               |
| `dismiss`     | No additional properties.                                                                                                                         |

No scripts, callbacks, expressions, or implicit navigation. `setState` must
preserve any text-field, selection, or sheet binding's scalar type at runtime;
renderer enforcement is part of #9300. Event sequence and transmission are
#9298/#9303. Dismissal does not remove the host's safety responsibilities.

### Re-showing an overlay

`show_overlay` always carries a full spec; there is no partial update (#10490).
When `spec.id` is the overlay already on screen and `reset` is absent or false,
the device replaces it in place: it keeps the display the overlay is on (the
request's `displayId` is ignored), and each pager keeps its settled page,
matched by pager id and clamped to the new page count. The new spec's `state`
is authoritative; values the user changed by tapping or typing are not carried
over unless the spec includes them. The window content is rebuilt from the new
runtime, so a text field shows the spec's value and edits still in flight from
the previous showing are dropped. Event sequences continue per id, as for any
re-show. `reset: true`, a different id, or nothing on screen is a fresh show:
pages start from the spec and the requested display is used. `reset` is only
sent when true; a device that predates it ignores the field and always starts
fresh. The host reports a `display` that a same-id show ignored as a `warning`
on the tool result.

### Presenting alternatives

The host has no carousel helper; `showVariants` and its on-device pick were
removed (#10489, #10488). An agent shows one design with `show`, explains it and
the others in the conversation, and shows the next on request, or shows one spec
whose `pager` holds every design with a visible label per page (see the
full-screen pager example below). The user chooses in chat; nothing waits on the
device for a choice. `pager`, `setPage` and `{page}`/`{pageCount}` interpolation
remain spec primitives for that.

## Anchors

#9316 specifies semantics but not exact field names. These are the chosen strict
shapes:

```json
{ "type": "bounds", "bounds": { "x": 12, "y": 48, "width": 300, "height": 56 } }
```

```json
{
  "type": "element",
  "selector": {
    "elementId": "42",
    "text": "Buy",
    "testTag": "buy",
    "container": { "elementId": "card" }
  },
  "alignment": "cover",
  "offset": { "x": 0, "y": 0 }
}
```

Bounds are screen-space dp; width/height are nonnegative. Element selector has
optional nonempty `elementId`, `text`, and `testTag` strings, and an optional container object, with
at least one supplied. Combined fields narrow the match. The container object uses the existing tap
container shape: exactly one nonempty `elementId` or nonblank `text`, optional
nonnegative integer `index` (up to 2147483647), optional `selectionStrategy`, and
an optional nested `container`. Anchors accept only `selectionStrategy: "unique"`
(default); first/random selection would contradict #9316's ambiguous-anchor
rejection. Container chains have a separate `MAX_OVERLAY_SELECTOR_DEPTH` of 8;
the first container has depth 1. The existing TypeScript
`ElementContainerSelector` type is reused. Strings are preserved as authored. Alignment is required: `cover`, `top`, `bottom`,
`start`, or `end`; optional offset defaults to zero. Cover adopts target bounds;
edge alignment aligns the same node edge to the target edge, centered along the
other axis, preserving authored node dimensions, then applies the offset.

The host resolves selectors against the app hierarchy with the overlay excluded,
converts pixels to dp once using the target display density, and accounts for
the overlay origin and cutout. Resolution happens at show, not live.
Missing or ambiguous elements fail the tool call before showing content, with
candidates and hierarchy timestamp handled by #9316/#9302. Anchors can be authored
in any placement: the host subtracts the window's screen origin; a floating
window is recommended when pass-through outside anchored content matters. Window
size is determined by placement/content, not by implicitly resizing to an anchor.
The renderer receives resolved dp bounds; the wire's resolved representation is
left to #9298/#9316.

## Safe area and IME

```json
{
  "safeAreaPadding": {
    "edges": ["bottom"],
    "types": ["systemBars", "ime"]
  }
}
```

Both arrays must be nonempty, with no duplicates. Edges: `top`, `bottom`, `start`,
`end`. Types: `systemBars`, `cutout`, `ime`. It mirrors Compose
`windowInsetsPadding`: take the selected inset types' union (maximum per edge),
apply only selected edges, and consume those insets for descendants. Insets are
additional to authored style padding. No padding is applied automatically.
Bottom navigation, bottom sheets, and text-field-bearing content normally opt
into bottom/systemBars, plus ime when the keyboard should move content. Cutout
padding is normally useful at top/start/end. Anchors stay in screen coordinates;
inset padding does not reinterpret their coordinate origin.

## Lifecycle and safety

Fullscreen windows reserve an opaque host row above clipped authored content, with
“Dismiss AutoMobile overlay”. Its visibility, style and opacity are independent of
the spec, including modal sheets and `window.opacity: 0`. The authored content
viewport excludes the host row; relative sheet detents use that remaining height.
Spec opacity continues
to apply to authored content and scrims; it cannot fade the safety control.

Every dismissal emits one `overlay_event` with `kind: "dismissed"`, null `name`,
and `payload: {"reason": "user|agent|disconnect|ttl|teardown"}` (one reason string).
Host and authored dismiss controls use `user`; `dismiss_overlay` uses `agent`;
last-client disconnect uses `disconnect`; idle expiry uses `ttl`; service teardown,
unbind/restart and owning-display removal use `teardown`. Sequence allocation
precedes delivery even if no socket remains. A show replacement closes the old
runtime silently and cancels its timer. Disconnect counts are captured at removal
with the existing observer-session generation so rapid reconnects cannot erase the
zero edge or dismiss a replacement from a new observer session. No state is
persisted across process restart.

Idle means no interaction or accepted show. The device fallback TTL is five
minutes (300,000 ms), positive and settable locally on the controller. Shows
(including a same-id show) and user interactions restart it (initial/restored
unchanged pager reports are rendering and do not count); configuration
changes and safety hide/restore do not. Hidden overlays still expire. The current
strict protocol has no TTL or device-session-release message: no wire field is
added here. Session release is covered only when it closes the last WebSocket;
a release that retains sockets requires a future daemon/device contract.

Rotation, density/size changes and fold posture callbacks refresh layout params
without recreating runtime or composition: authored state and settled pager pages
survive with no event or sequence allocation. If the owning display disappears,
dismiss rather than moving content onto another display; it never revives on return.
V1 uses the service's default display; display selection remains #9308.

Show-time keyguard/screen checks fail closed. Screen and window signals hide the
window while locked or noninteractive and restore the same runtime on unlock;
no dismissal event is emitted for temporary hiding. Own-package accessibility
events are dropped before hierarchy debouncing and navigation tracking.

Deferred: foreground-package scoping needs a reliable application-window policy;
`package_event` reports package installation/removal, while window-state events
also include IME, dialogs and System UI. Secure app-window detection has no trusted
existing signal. Automatic bottom-sheet IME movement/yield is also deferred:
node-level inset selection exists, but smaller edge-to-edge sheet windows do not
yet have verified keyboard geometry. Existing explicit `safeAreaPadding` behavior
is preserved. Device checks must cover keyguard timing, daemon death, pager page 3
across rotation, fold/display removal, and API 30/34/36 keyboard/cutout geometry.

## Rejection paths and deterministic first error

Paths omit a leading `$` for ordinary root members: `root.children[1].style.color`.
Array indices use brackets. Non-identifier keys use JSON-quoted brackets, e.g.
`root["bad.key"]`; top-level equivalents start with `$["bad.key"]`. A whole
input, malformed JSON, or spec byte error uses `$`. Missing/unknown discriminator
errors end in `.type`. Paths identify the rejected input, before any defaults.

Both walkers use the same sequence:

1. Raw UTF-8 byte limit, then strict JSON parsing (syntax error at `$`).
2. Depth-first structural walk. At a node entry, check node count, node depth,
   then image-use count. Nav image uses are checked at item entry. Container depth is checked at
   container reference entry. At a tagged
   object, check its discriminator first.
3. At each object, visit the union of present and declared keys in ascending
   UTF-16 lexicographic order, independent of JSON insertion order. Unknown keys
   fail at their own path; missing required keys fail there too. Arrays visit
   increasing indices, with length checked first and uniqueness after each item.
   Selection binding exclusivity is checked after its fields, at `.pager` for
   both/neither. An empty selector fails at `.selector`. Container exclusivity fails at
   `.elementId` after its fields are checked.
4. After structure passes, find duplicate pager IDs in node preorder (second
   ID fails at `.id`); then resolve node pager references in preorder, then action
   pager references in encounter order. Finally check initialized text/nav state
   binding types in node preorder, then existing sheet state types in node
   preorder.
5. Decode typed models. Any schema/model disagreement is an internal contract
   failure at `$`, never successful partial content.

Lexicographic order avoids dependence on property insertion order or library
union error ordering. The shared rule table reduces vocabulary duplication, but
walkers and model decoders remain independent. Neither implementation parses
Zod or kotlinx.serialization exception messages. Human error messages describe
the failure; exact path parity is the shared contract.

JSON supplied as an already-decoded TypeScript value is measured as compact
JSON, while string input measures original bytes. Only JSON-representable values
are accepted. Duplicate JSON object keys must be avoided by authors; standard
JSON decoders retain the last value. They are not unknown fields.

## Worked examples

### Full-screen variants with pager tabs

```json
{
  "id": "variants",
  "window": { "placement": { "type": "fullscreen", "scrim": "#80000000" }, "opacity": 80 },
  "state": { "query": "", "open": false },
  "root": {
    "type": "column",
    "safeAreaPadding": { "edges": ["top", "bottom"], "types": ["systemBars", "cutout", "ime"] },
    "children": [
      {
        "type": "tabBar",
        "pager": "pages",
        "items": [
          { "label": "Original", "icon": "home" },
          { "label": "Edited", "image": "variant-b" }
        ]
      },
      {
        "type": "pager",
        "id": "pages",
        "children": [
          {
            "type": "scroll",
            "axis": "vertical",
            "child": { "type": "text", "text": "Page {page} of {pageCount}" }
          },
          { "type": "image", "asset": "variant-b", "contentScale": "fit" }
        ]
      },
      { "type": "textField", "stateKey": "query", "placeholder": "Feedback" },
      {
        "type": "text",
        "text": "Next",
        "onTap": [{ "type": "setPage", "pager": "pages", "page": "next" }]
      },
      {
        "type": "bottomSheet",
        "openWhen": { "key": "open", "equals": true },
        "detents": ["half", "full"],
        "child": { "type": "text", "text": "Details" }
      }
    ]
  }
}
```

### Bottom window sheet with state navigation and horizontal scrolling

```json
{
  "id": "choices",
  "window": { "placement": { "type": "sheet", "edge": "bottom", "height": 240 } },
  "state": { "selected": 0 },
  "root": {
    "type": "column",
    "children": [
      {
        "type": "scroll",
        "axis": "horizontal",
        "child": {
          "type": "row",
          "children": [
            {
              "type": "text",
              "text": "Save",
              "onTap": [{ "type": "emit", "name": "save", "payload": { "variant": "A" } }]
            },
            { "type": "spacer", "style": { "width": { "dp": 16 } } },
            {
              "type": "icon",
              "name": "favorite",
              "onTap": [{ "type": "setState", "key": "selected", "value": 1 }]
            }
          ]
        }
      },
      {
        "type": "bottomNav",
        "stateKey": "selected",
        "safeAreaPadding": { "edges": ["bottom"], "types": ["systemBars"] },
        "items": [
          { "label": "Home", "icon": "home" },
          { "label": "Favorites", "icon": "favorite" }
        ]
      }
    ]
  }
}
```

### Floating anchored replacement

```json
{
  "id": "button-preview",
  "window": {
    "placement": { "type": "floating", "gravity": "topStart", "offset": { "x": 24, "y": 120 } },
    "opacity": 50
  },
  "root": {
    "type": "box",
    "anchor": { "type": "element", "selector": { "testTag": "buy" }, "alignment": "cover" },
    "style": { "background": "#2255CC", "cornerRadius": 12 },
    "children": [{ "type": "text", "text": "Buy now", "onTap": [{ "type": "dismiss" }] }]
  }
}
```

## Shared verification and sibling updates

Both test suites enumerate the same `test/fixtures/overlay-spec/valid` and
`invalid` JSON files, assert nonempty directories, and require coverage of every
node/action/placement. Invalid files wrap `{spec, expectedPath}`. The byte limit
has no fixture file: each suite generates its own input and checks the exact
boundary in bytes, including whitespace, as well as the emit payload boundary.
Fixture and contract files are pinned to LF for Windows. No binary assets are
included. Worked examples above are also committed as valid fixtures and decode in both
suites. The page is registered under How it Works in `mkdocs.yml` and linked from the
design index. The existing system-tray page remains in its internal `not_in_nav`
registration; this public contract has an explicit navigation entry.

Sibling follow-ups: #9300 must include horizontal scroll, tabs/navigation, and
modal sheet state; #9298 must use the envelope's `id` and `window` rather than
introducing conflicting separate placement/spec identity; #9316 must adopt the
anchor field names and selected placement/origin rules; #9301 must use opaque
asset strings and count nav images as spec image uses; #9296 must remove its
`specVersion` proposal. #9295's root-level opacity wording maps to
`window.opacity`, and its focusability wording follows the later device findings.
No sibling issues are edited as part of this implementation.
