# Agent-authored prototype specification

Current, unversioned contract for the agent-authored prototype (#9296, child of #9295). Android Compose
rendering, asset transport, the wire messages, the `prototype` MCP tool and the
[iOS simulator agent](../ios/prototype-agent.md) implement it; the iOS
[feature support table](../ios/prototype-agent.md#feature-support) lists what is Android only (`display`,
`window.layer: "app"`, `window.persistence: "device"`, `inspect`, idle TTL). A spec accepts no code except the opt-in Android-only AGSL asset referenced by `style.shader`,
expressions, URLs, image bytes or migration instructions.

## Owner decisions

- 2026-10-27: `style.surface: "glass"` requires real glass and `prototype_glass_v1`: iOS 26+ Liquid Glass, and Android API 31+ real backdrop blur when its renderer is implemented. iOS 17–25 and Android below API 31 refuse glass through missing capability advertisement. There is no simulated translucent fill, ultraThinMaterial substitute, or fallback capability. Android rendering and device verification remain owed by the Android renderer slice.

- 2026-10-26: Android-only custom AGSL shaders require `prototype_custom_shaders_v1` and the host opt-in `AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1` (off by default). Source assets use `application/vnd.automobile.agsl`, valid UTF-8, at most 16 KiB (16384 bytes), and at most 16 scalar `uniform float name;` declarations. The only other permitted uniform is one optional `uniform shader content;`: only the node's own rendered content may be sampled. Comments (`//` and `/* */`) are stripped to separators before token scanning. Code tokens must be ASCII; no preprocessor directives, strings, escapes, qualifiers, arrays, initializers, comma declarations, duplicate names, or other uniform types/samplers are accepted. `content`, `main`, GLSL/AGSL reserved words and names starting with `sk_` or `gl_` are reserved uniform names. A leading UTF-8 BOM is rejected. `style.shader: {asset, uniforms?}` supplies at most 16 declared float names matching `[A-Za-z_][A-Za-z0-9_]*`, with finite values in [-1000000, 1000000]; the host cross-checks available source assets. The Android runtime must compile on `put_prototype_asset` before retaining source and cap returned errors at 2 KiB of UTF-8. Execution fails closed under the preset frame-budget guard. iOS agents and ProtoViewer bundle import/export explicitly refuse both this MIME type and `style.shader`.

The 2026-10-04 decisions supersede the issue's earlier proposals:

- Envelope: `{ id, window, data?, state?, root }`, with no `specVersion`. An older or
  newer shape is rejected rather than migrated.
- Every object is strict: unknown properties, unknown node/action types, explicit
  null for optional fields, and wrong types reject the entire spec with a path.
- Scroll supports both axes. Amended for #12071: pager defaults to horizontal full-page
  paging and optionally accepts `axis`, `pageSpacing`, `peek` and `pageSize` on a device
  advertising `prototype_pager_options_v1`. Indicator and carousel remain deferred.
- Navigation includes `tabBar` and author-positioned `bottomNav`, bound to a pager
  or a number state key.
- Windows are edge-to-edge. Safe-area padding is an explicit node opt-in.
- A `sheet` window and a modal `bottomSheet` node are separate concepts.
- Built-in icons come from a closed list (the bundled Material icon set); other artwork uses image assets.

The 2026-10-26 decisions (#15244) fix the native-look and motion-profile work:

1. **Default look.** `theme.design` defaults to `platform`. iOS prototypes look native by default
   where native coverage exists. On Android `platform` is still Material.
   `material` stays available to force today's drawing on both platforms.
2. **Other-platform namespaces.** A renderer ignores the other platform's namespace block (`ios: {...}`
   on Android, `android: {...}` on iOS) and adds a `platformNotes` entry; it does not refuse the spec,
   so one spec runs on both. This matches iOS ignoring `window.layer: "app"`.
3. **iOS Reduce Motion** maps to the _reduced_ profile (crossfades), not to _off_. The system
   setting `UIAccessibility.prefersCrossFadeTransitions` maps to _reduced_ as well.
4. **Native controls without per-item identifiers** (segmented `Picker`, `TabView`, `Menu`) keep the
   custom-drawn fallback. Each control is revisited after #15462.
5. **`surface: "glass"` on Android** waits for real backdrop blur (API 31+ `RenderEffect`, after the
   #15126 spike). Below API 31 glass is refused (2026-10-27 owner decision).
6. **Width classes** are native per platform. Android reports the Material window size classes
   (compact, medium, expanded); iOS reports only its horizontal size class (compact, regular). Specs
   branch per platform.
7. **Xcode 27.** An advisory (non-required) Xcode 27 iOS build runs on the self-hosted Macs now. The
   required jobs switch after a green week. #15261 proceeds behind `#available`.

Earlier decisions still apply: the renderer is Compose; sizes and positions use
dp; prototype opacity is a percentage; app-element anchoring is supported; observe
includes prototype nodes by default; existing tap/text tools target prototype nodes;
screenshots come from observe, with no separate screenshot tool. Focus management
belongs to the window host: accessibility set-text does not require focus, while
human keyboard input does (the later device findings in #9300 supersede the older
blanket focusability proposal).

## Envelope and limits

| Property  | Type / meaning                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`      | Required nonempty prototype identifier string.                                                                         |
| `window`  | Required window configuration below.                                                                                   |
| `data`    | Optional agent-owned read-only nested JSON object; see Data model.                                                     |
| `state`   | Optional flat object of string, finite number, or boolean values.                                                      |
| `motion`  | Optional `none`, `standard` (default), `reduced` for alpha-only scroll motion, or `expressive`. See Motion below.      |
| `storage` | Optional `{version, keys}` naming state keys and `/data` pointers the device keeps across shows. See Storage (#12522). |
| `root`    | Required single node.                                                                                                  |

All numeric values are finite. State keys (including action/binding/condition
keys) match `[A-Za-z_][A-Za-z0-9_]{0,63}`. No nested state, arrays, or nulls.
Prototype IDs, pager IDs, tags, event names, and asset IDs are opaque nonempty
strings; they do not share the state-key restriction.

| Constant                             | Value           | Counting rule                                                                                                                                                                                           |
| ------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_PROTOTYPE_NODES`                | 2000            | Includes root and every child/page/sheet child; `repeat` templates count once per instance, except lazy `list` row templates, which count once (including when empty); list headers/footers count once. |
| `MAX_PROTOTYPE_LIST_ITEMS`           | 2000            | Maximum rows per lazy list, read from its data path; ordinary path repeats remain capped at 128.                                                                                                        |
| `MAX_PROTOTYPE_DEPTH`                | 24              | Root has depth 1; only node nesting counts.                                                                                                                                                             |
| `MAX_PROTOTYPE_IMAGES`               | 32              | Counts image nodes and nav item image uses, including hidden ones; repeated asset IDs count again; lazy list row templates, headers and footers count once.                                             |
| `MAX_PROTOTYPE_SPEC_BYTES`           | 1048576 (1 MiB) | UTF-8 bytes of raw JSON, including whitespace.                                                                                                                                                          |
| `MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES` | 16              | Maximum named bindings per emit.context.                                                                                                                                                                |
| `MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES`   | 4096 (4 KiB)    | Conservative compact JSON byte budget for each emit payload; numbers reserve 32 bytes.                                                                                                                  |

Feed-scale budgets (#14183). Lazy-list rows live in `/data`, so `MAX_PROTOTYPE_DATA_ARRAY_ITEMS` never sits
below `MAX_PROTOTYPE_LIST_ITEMS`, and `list.maxItems` shares the list cap. Data may use
`MAX_PROTOTYPE_DATA_BYTES` (786432) of the spec, which stays below `MAX_PROTOTYPE_SPEC_BYTES` so the node
tree keeps room. `MAX_PROTOTYPE_DATA_WRITE_BYTES` equals it: later host patches re-validate the whole spec
against the data cap, so a write cap above it would let paging grow data that no patch could survive. The
response cap (256 KiB) stays below both. The whole-spec byte, node, depth, image, storage and in-flight limits
are independent of row count: they bound frame size, memory and tree cost, and none of them grows with lazy
rows. A row carries at most `MAX_PROTOTYPE_REPEAT_PATH_CELLS` / `MAX_PROTOTYPE_LIST_ITEMS` (32) scalar fields
across a full list. Host validation is linear in rows (a 2000-row feed validates in tens of milliseconds;
`benchmark/prototype-feed-limits.ts`). Feeds beyond these caps page or trim with `maxItems`; per-runtime
budgets and multi-spec apps are not part of the contract.

Navigation item `image` uses count toward `MAX_PROTOTYPE_IMAGES`. Assets have separate transport and
decoded-memory limits (Asset transport). Emit payload nesting is bounded by
`MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH` (24, root payload depth 0). The emit byte budget counts every finite
number as 32 bytes, so JVM and JS number spellings cannot disagree, and everything else as compact JSON
UTF-8; it can conservatively reject numeric-heavy payloads. Raw number token length and whitespace are
governed by the spec-byte limit. Nonfinite numbers are rejected everywhere, including emit payloads.

Every onTap list has 1-32 actions; tab bars have 1-32 items; bottom navigation has 2-5 items; sheet detents
have 1-8 entries.

The single structural rule source is `schemas/prototype-spec-contract.json`, imported by TypeScript and
packaged as a JVM protocol resource. TypeScript's Zod schema supplies inferred types and the final typed
decode; Kotlin uses kotlinx.serialization sealed hierarchies. `validatePrototypeSpec` /
`PrototypeSpecValidator.validate` are the complete entry points (structure, limits and cross-references
precede typed decode); never bypass them with a model decoder. Untagged dimension, detent, page-target and
scalar unions have explicit Kotlin serializers; only arbitrary emit payloads keep `JsonElement`. Validated
integer fields normalize decimal/exponent spellings before Kotlin decoding (`100.0` and `1e2` both mean
100). The protocol module has no API-dump task; its artifact includes the contract resource.

## Data model (#11673)

`data` is an optional top-level plain JSON object, agent-owned and read-only on the device (objects, arrays,
strings, finite numbers, booleans; no null; arbitrary object keys). `state` stays the user-owned scalar map:
`setState`, `toggle`, `increment`, `decrement` target only declared state keys, including per-row keys; a
key present only in data fails like any undeclared key. A full `show` replaces data. CtrlProxy and the iOS
agent advertise `prototype_data_model_v1`.

Limits (`schemas/prototype-spec-contract.json`): `MAX_PROTOTYPE_DATA_BYTES` 786432,
`MAX_PROTOTYPE_DATA_DEPTH` 8 (data is depth 1; only containers add depth), `MAX_PROTOTYPE_DATA_ARRAY_ITEMS`
2000, `MAX_PROTOTYPE_DATA_POINTER_LENGTH` 256 UTF-16 units. Byte cost reuses the emit payload cost (32 bytes
per number regardless of digits), so numeric-heavy data reaches the limit early.

Pointers are nonempty RFC 6901 paths relative to data, matching `^(?:/(?:[^~/]|~[01])*)+$`. Split after the
leading slash; decode `~1` to `/`, then `~0` to `~`. Resolution follows exact own members, including empty
or numeric-looking keys (`/a/` is the empty key inside `a`). Array indices match `0|[1-9][0-9]*` and must be
in bounds; `01`, `-`, `1.0`, negatives and traversal through a scalar are missing. No data means every path
is missing.

### Bindings and ordering

```json
{
  "data": { "orders": [{ "id": 7, "title": "Latte", "total": 4.5 }], "cartCount": 1 },
  "state": { "liked_7": false },
  "root": {
    "type": "column",
    "repeat": { "items": { "path": "/orders" }, "as": "item", "key": "id" },
    "children": [
      {
        "type": "text",
        "text": "{item.title} ({data:/cartCount})",
        "visibleWhen": { "data": "/cartCount", "gt": 0 },
        "onTap": [{ "type": "toggle", "key": "liked_{item.id}" }]
      }
    ]
  }
}
```

- `repeat.items` is the literal list or a strict `{path}` that statically resolves to an array of objects
  within the 128-item maximum (empty is valid and gives zero instances). Each item is projected to scalar
  members whose names match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; nested members stay in data and are invisible to
  templates. Optional `repeat.key` names a projected field present in every item; rendered identities use
  scalar text rendering and must be unique (7 and "7" collide), for literal lists too. Per-item field,
  state-key, action and expanded node/image checks still run. Templates cannot nest repeats or pagers.
- `MAX_PROTOTYPE_REPEAT_PATH_CELLS` bounds the sum across path-bound repeats in pre-order after component
  expansion (empty templates included): each instantiated object item costs its projected scalar members, or
  one if none; literal repeats are free. After the three path-source checks, exceeding it fails at
  `<node>.repeat.items.path` with `Repeat path cell limit exceeded`, before projection. Cell counts and
  projected lists are cached by pointer within a validation call.
- `MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH` (16384 UTF-16 units) bounds the sum of replacement lengths per
  bindable field at each substitution stage (data in text-kind fields, then repeat in every bindable field
  per item, including repeat placeholders inserted by data). Literal characters, unresolved repeat
  placeholders and state placeholders (state changes after show) are not counted.
  `MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL` (4194304 units) bounds rebuilt text per validation: each recognised
  data stage and each repeat item charges authored stage length plus replacement length (a data-resolved
  field inside a repeat is charged once per item). Purely literal fields and state placeholders are free.
  Crossing it fails at the field with `Substituted text total limit exceeded`. During state interpolation a
  replacement that would exceed the per-call limit stays as written and later placeholders may still
  substitute.
- `{data:<pointer>}` is recognised by a plain scan to the next closing brace; invalid placeholders stay
  literal and never make text invalid. It binds only text-kind fields: `text.text`, `button.label`,
  `fab.label`, `segmentedButton.options[].label`, `topAppBar.title`, `topAppBar.navigationIcon.label`,
  `topAppBar.actions[].label`, `dialog.title`, `dialog.text`, `dialog.confirm.label`, `dialog.dismiss.label`,
  `snackbar.text`, `snackbar.action.label`. It never binds state keys, operands, emit names/payloads or
  content descriptions, and component props never reach it. Scalars render normally (integral numbers
  without decimal point or exponent); missing/object/array values render empty. Binding order: data, then
  repeat placeholders, then state interpolation. An inserted data string is plain text: `{item.x}`,
  `{index}` and `{key}` inside it bind afterwards like authored text, it is never rescanned for data
  placeholders, and data values cannot be escaped.
- A condition uses exactly one of `key`, `data`, `platform`, `valid`, `all`, `any`, `not` (see Conditions). A `key` or `data` form
  takes exactly one comparison: `equals` (same scalar type and value; numbers by value, -0 equals 0),
  `notEquals` (its inverse, including missing or non-scalar), `gt` or `lt` (numbers only, otherwise false), or data-only `empty`. State-key forms additionally accept `contains`, `startsWith`, `lengthGt` or `lengthLt`.
  Data `equals`/`notEquals` operands are literals; a repeat placeholder there is rejected (state operands
  still bind). `bottomSheet.openWhen` keeps its boolean `{key, equals}` form. Component props are never
  bound in `repeat.items.path` or a condition's `data`; `repeat.key` passes through expansion unchanged.

The host validates data and repeat paths and sends authored bindings unchanged. The device resolves them
before repeat expansion: path items are projected, text is bound, conditions become in-memory constants. All
data-model uses (top-level data, path items, `repeat.key`, data conditions, recognised text placeholders)
require `prototype_data_model_v1`; the host refuses an older device before any upload or show, naming the
first usage field (data first, then node fields in document order, depth-first), counting the others, with
an update/relaunch hint and a literal-content fallback. `status` reports a deep copy of the last successful
show's data next to state, `inspect` reports and adopts device data, dismiss clears it, absent data is
omitted. Events never carry data.

Android: CtrlProxy keeps the original validated spec for state-write validation, persistence, replay and
status. Both render entry points (`mapPrototypeSpec` and the runtime's incremental mapper) resolve the
authored spec; the runtime caches the resolved root per (root, data) identity pair and the resolved spec per
authored spec instance, so state writes and repeated `renderModel()` calls do not re-resolve. The controller
guards the authored tree, checks authored anchors before validation (to preserve error precedence),
validates, resolves, guards the resolved tree, and re-checks anchors if resolution changed the root.
Appearance and anchor layout consume the resolved render tree. `repeat.key` is carried on the model: keyed
Compose rows retain identity across patches and reordering, unkeyed rows keep positional identity.

### Validation paths and reporting

Data is walked depth-first, with sorted object keys and array index order. At each container,
depth precedes array length, then children; the byte check runs last.

| Path                                                                                      | Message                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`                                                                                    | `Expected object` when the root is not a plain object                                                                                                                 |
| Offending data container                                                                  | `Data depth limit exceeded` or `Data array limit exceeded`                                                                                                            |
| Offending value, e.g. `data.orders[0].title` or `data["a b"]`                             | `Invalid data value`                                                                                                                                                  |
| `data` after the walk                                                                     | `Data byte limit exceeded`                                                                                                                                            |
| Pointer field                                                                             | `Invalid pointer value`                                                                                                                                               |
| `<node>.repeat.items`                                                                     | `Invalid union value` for neither array nor object                                                                                                                    |
| `<node>.repeat.items.path` (in this order)                                                | `Repeat path does not resolve to an array`; `Repeat path resolves to more than 128 items`; `Repeat path item <i> is not an object`; `Repeat path cell limit exceeded` |
| Bindable field                                                                            | `Substituted text total limit exceeded` (reduce bindable fields, replacement lengths or repeat items; `MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL`)                         |
| Authored bindable field, e.g. `root.children[0].text` or `root.children[0].onTap[0].name` | `Substituted text length limit exceeded` (after unknown repeat fields, before bound key/empty emit checks)                                                            |
| Referencing template string                                                               | `Unknown repeat field "x"` (non-scalar members count as absent)                                                                                                       |
| `<node>.repeat.items.path`                                                                | `Bound state key "<k>" is invalid (repeat item <i>)`; literal repeats keep `<node>.repeat.items[i]` without the suffix                                                |
| `<node>.repeat.key`                                                                       | `Unknown repeat field "<key>"`; `Duplicate repeat key "<text>" (items <i> and <j>)`, first colliding pair                                                             |
| Condition `.key`                                                                          | `Exactly one of key, data, platform, all, any, not, valid is required`                                                                                                |
| Condition comparison field                                                                | `Requires key or data or platform`; `Requires key`; `Exactly one of equals, notEquals, gt, lt, empty, contains, startsWith, lengthGt, lengthLt is required`           |
| Condition `.equals` / `.notEquals` in bindable visiting order                             | `Repeat placeholder in a data condition operand is not supported`                                                                                                     |
| `<node>.repeat`                                                                           | Existing expanded node/image limit errors                                                                                                                             |

## Theme

Optional top-level `theme` selects the design and sets the scheme components draw
from. At least one of its fields is required:

| Field                         | Meaning                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design`                      | `material` or `platform` (default). Explicit `platform` requires `prototype_design_platform_v1`; omission silently retains today’s drawing on older renderers.                    |
| `mode`                        | `light`, `dark` or `system` (follow the device). Omitted: inferred from the first opaque background on the root's leading chain, else the device setting.                         |
| `colors.seed`                 | Hex color a full light or dark scheme is generated from.                                                                                                                          |
| `colors.source`               | `device`: Android 12+ (API 31) dynamic color. On older devices it falls back to `colors.seed` when present, else the default scheme.                                              |
| `colors.<role>`               | Hex override for one Material 3 role (`primary`, `onPrimary`, `surface`, `surfaceContainer` … the 36 roles style colors accept), applied over the seed, device or default scheme. |
| `colors.light`, `colors.dark` | Maps of role name to hex, applied after `colors.<role>` in the matching mode only. See [Light and dark values](#light-and-dark-values).                                           |
| `typography.scale`            | Number 0.75–1.5 multiplying the size and line height of every Material type role. Default 1.                                                                                      |
| `typography.fontFamily`       | `sans`, `serif` or `mono`: the family of every Material type role.                                                                                                                |
| `shapes.corner`               | `none`, `small`, `medium` (the stock Material 3 scale), `large` or `full` (pill). Shifts every corner family built-in components use.                                             |

`colors`, `typography` and `shapes` each need at least one field. An explicit theme wins over the scheme
inferred from backgrounds.

Role overrides are literal colors, so they apply unchanged in light and dark: pair them with a
fixed `mode`, or rely on `seed`/`source` for a mode-aware scheme and override only the roles that
must match a brand. With no `mode`, a `colors.background` (else `colors.surface`) override decides
light or dark from its luminance, ahead of the authored-background inference, for both the content
scheme and the host dismiss control. A spec that names only roles in its styles and no hex
literals renders in light and dark from one source.

A text node's `style.textStyle` names a Material 3 type role (`displayLarge` … `labelSmall`, 15
in all) and so follows the theme's scale and family. It supplies size, weight and family; an
explicit `textSize`, `fontWeight` or `fontFamily` on the same node still wins. Plain text
without `textStyle` keeps its authored 14 sp default and is not scaled; it takes the theme's
`typography.fontFamily` only when it names no `fontFamily` of its own.

A text node with no `color` draws in the theme's content colour (`onSurface`). A `cornerRadius` token maps to the
theme's Shapes (`shapes.corner` shifts them), `none` is square and `full` a pill. A
role-valued `background` does not take part in inferring the prototype's light/dark
theme from authored backgrounds (it would be circular); set `theme.mode` or
`colors.seed` for that.

### Design coverage

The contract's `designCoverage` table records the current drawing for each node. `neutral`
means layout or content with no design language of its own. Android's platform look is Material.
On iOS, explicit `theme.design: "platform"` reports `design.fallback` platform notes for Material
nodes (first 20 paths, with `total` when larger). Omission and `material` report no design fallback
notes. The four native entries already use SwiftUI controls; changing the default changes no drawing.
There are no iOS prototype screenshot baselines to re-record.

| Node            | iOS      | Android  | Parts |
| --------------- | -------- | -------- | ----- |
| badge           | material | material | —     |
| bottomNav       | material | material | —     |
| bottomSheet     | material | material | —     |
| box             | neutral  | neutral  | —     |
| button          | native   | material | —     |
| card            | material | material | —     |
| carousel        | neutral  | neutral  | —     |
| chart           | material | material | —     |
| checkbox        | material | material | —     |
| chip            | material | material | —     |
| column          | neutral  | neutral  | —     |
| datePicker      | native   | material | —     |
| dialog          | material | material | —     |
| adaptive        | material | material | —     |
| drawer          | material | material | —     |
| tooltip         | material | material | —     |
| divider         | neutral  | neutral  | —     |
| fab             | material | material | —     |
| flow            | neutral  | neutral  | —     |
| grid            | neutral  | neutral  | —     |
| icon            | neutral  | neutral  | —     |
| iconButton      | material | material | —     |
| image           | neutral  | neutral  | —     |
| list            | material | material | —     |
| listItem        | material | material | —     |
| menu            | material | material | —     |
| pager           | neutral  | neutral  | —     |
| pasteButton     | native   | material | —     |
| progress        | material | material | —     |
| radioGroup      | material | material | —     |
| row             | neutral  | neutral  | —     |
| scroll          | neutral  | neutral  | —     |
| searchBar       | material | material | —     |
| segmentedButton | material | material | —     |
| select          | material | material | —     |
| slider          | native   | material | —     |
| snackbar        | material | material | —     |
| spacer          | neutral  | neutral  | —     |
| stack           | neutral  | neutral  | —     |
| switch          | material | material | —     |
| tabBar          | material | material | —     |
| text            | neutral  | neutral  | —     |
| textField       | material | material | —     |
| timePicker      | native   | material | —     |
| topAppBar       | material | material | —     |

### Light and dark values

A shown prototype has exactly one resolved mode, light or dark: an explicit `theme.mode`
(`system` reads the system setting), else the luminance of a flat `colors.background` (else
`colors.surface`) override, else the first opaque hex background on the root's leading chain, else
the system setting. Every per-mode form below reads that one resolved mode. A device needs
`prototype_theme_modes_v1` for them; the host refuses such a spec for an older CtrlProxy.

- **Colour pairs.** Every colour slot (`style.background`, `style.color`, `style.shadowColor`,
  `style.border.color`, gradient stops, `window.placement.scrim` and the `bottomSheet` `scrim`,
  including inside `styleWhen`) accepts a hex value, a role name, or `{light, dark}` where each
  side is a hex value or a role name. Both sides are required. The side for the resolved mode is
  taken first, and is then a literal colour or a role looked up in the active scheme.
- **Role maps.** The scheme is built in this order: seed, device or default scheme, then the flat
  `colors.<role>` overrides (both modes), then `colors.light` or `colors.dark` for the resolved
  mode. A role named in both the flat overrides and the mode map takes the map's value in that
  mode and the flat value in the other. A role name inside a pair resolves against this final
  scheme, so there is no precedence to decide between a node's pair and the theme maps: the pair
  picks the name or literal, the scheme supplies the role's colour.
- **Mode inference ignores per-mode values.** `colors.light` / `colors.dark` and a `{light, dark}`
  background never decide the mode, because they depend on it. A pair background is skipped by
  the authored-background inference in the same way a role-named background is, and the search
  continues down the leading chain. A spec whose only backgrounds are pairs or roles follows the
  device setting.
- **Gradient stops** accept role names; a role is the scheme's colour unchanged.
- **Scrims** (`window.placement.scrim` and the `bottomSheet` `scrim`) accept role names with one
  special case. The `scrim` role, alone or as the side of a pair for the resolved mode, draws the
  scheme's scrim colour at the default scrim opacity (40%), the same value an omitted `bottomSheet`
  scrim uses, so `"scrim": "scrim"` dims rather than hides the app. Any other role (`surface`,
  `primary`, …) draws its scheme colour unchanged, which is opaque unless the theme overrides it
  with alpha. A hex scrim keeps exactly its authored alpha. A `dialog` authors no scrim; its
  fixed scrim is the `scrim` role at 32%.
- **Component colours.** A role name or pair in `style.color` on a `button`, `checkbox`, `switch`,
  `radioGroup` or `listItem`, and in `style.background` on a `card` or `listItem`, resolves
  against the theme like any other colour slot. Before `prototype_theme_modes_v1` only a hex value
  took effect in those slots.
- **Images.** `image.asset` and a `tabBar`/`bottomNav` item `image` accept
  `{light: assetId, dark: assetId}`. Only the asset for the resolved mode is decoded and drawn;
  both ids are checked at `show` and reported in `missingAssets`, and both stay retained with the
  prototype.
- **Window metadata.** `prototypeOpaque` follows what is drawn. The root background and window scrim are resolved in the show's mode and count as solid only when fully opaque (an opaque role counts; the `scrim` role in a scrim slot never does). The root counts only when drawn over the whole window (#11408): `width` and `height` both `fill`, no `anchor`, no `maxWidth`/`maxHeight` cap, no `aspectRatio`, no non-zero `offset`, no rounded corner and no `pressScale` below one. A root failing any of these lets the app show at an edge or corner, so only an opaque fullscreen scrim behind it can still make the window opaque. A chromeless fullscreen window can report `true` when opacity is 100 and its root or scrim is solid; a fullscreen window with the translucent dismiss bar still reports false.

### Live appearance (#11221, `prototype_appearance_v1`)

The controller resolves the mode once per show and keeps it current. That one value drives the host chrome (dismiss bar, Close control), the window scrim, every colour and image pair and the window metadata, so they cannot draw in different modes. No window reads its own Compose configuration for it, so windows from a display or app-layer window context follow the same value.

- **Override.** `show_prototype` takes a top-level `appearance`: `"device"` (default), `"light"` or `"dark"`. It stands in for the system setting only: it decides a spec with `theme.mode: "system"` or one whose mode would otherwise fall through to the device, and does not beat an explicit `light`/`dark` mode, a flat `background`/`surface` override or an authored opaque background. It belongs to the show (a later show of the same id without it follows the device). An unknown value fails the request and leaves what is showing untouched.
- **Re-theme.** The mode is resolved again after each interaction (a pager page or `styleWhen` state can change the background it is inferred from) and on every configuration change (night mode; on API 31+ the Material You palette, so `colors.source: "device"` re-reads after a wallpaper change). The window, runtime, state, pager pages and text-field contents are kept; only colours change. A prototype hidden by the lock screen or because its app left the foreground is resolved too and returns in the current mode.
- **Event.** When the resolved mode changes the device sends one `prototype_event` with `kind: "appearance_changed"`, `name: null`, `payload: {mode, source}` on the normal sequence, buffering and replay path. Nothing is sent when the mode stays the same (repeated configuration change, device flip under an explicit mode or override, palette change), nor for the show itself.
- **Report.** A successful `show_prototype` result and each `inspect_prototypes` entry carry `appearance: {mode, source, deviceDark}`. `source` names the deciding step: `explicit`, `override`, `roleLuminance`, `authoredBackground` or `system` (`theme.mode: "system"` reports `system`, or `override` when the show pinned it). `deviceDark` is the device's own setting. The host `prototype` tool reports it only in device answers (show, inspect), not host-local `status` (#11416). The prototype's window entry in a hierarchy capture carries it as `prototypeAppearance` next to `prototypePlacement` and `prototypeOpaque`; an APK without `prototype_appearance_v1` omits it.

## Windows

`window` has required `placement` and optional integer `opacity` (0–100, default
100). Opacity fades authored content and scrims. Fullscreen windows (with either
chrome mode) and persistent non-fullscreen windows keep their host controls opaque.

| Placement `type` | Properties                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `fullscreen`     | Optional `scrim` color. Occupies the display and blocks app touches.                                                     |
| `sheet`          | Required `edge`: `top` or `bottom`; required positive `height` in dp. App stays touchable outside the window.            |
| `floating`       | Required `gravity` from the alignment list below; required `offset: {x, y}` in dp. Outside-window touches reach the app. |

Root fills the entire window, including behind system bars and cutouts; ordinary
style constraints apply to its content. A floating/sheet root fills that smaller
window, not the entire display. No display selection is defined here (#9308).

Optional `layer` (#10496) is `system` (default) or `app`. `system` is
`TYPE_ACCESSIBILITY_OVERLAY`, above system UI including SystemUI's screenshot
flash and preview. `app` is `TYPE_APPLICATION_OVERLAY`, just above apps: the
shade, keyboard, toasts, system dialogs and the screenshot preview draw over the
prototype, the status and navigation bars draw over a fullscreen one (safe-area
padding matters more), and the keyboard covers its text fields like a real app's.
Non-default displays create their window context with the matching type. `app`
needs SYSTEM_ALERT_WINDOW; the host grants it with
`adb shell appops set dev.jasonpearson.automobile.ctrlproxy SYSTEM_ALERT_WINDOW allow`
before the show, and the device refuses the show with that command when it is
still missing. Application overlays are not trusted for touch pass-through on
Android 12+, so gestures dispatched through an `app` prototype can be blocked as
untrusted touches.

Optional `persistence` (#10494) is `session` (default) or `device`. See
Lifecycle and safety. Both fields are honoured only by a CtrlProxy that advertises
`prototype_window_options_v1`; the request decoder ignores unknown spec fields, so
the host refuses them for an older device instead of sending them.

Optional `chrome` (#12064) is `none` (default) or `bar`, fullscreen placement only,
on a device advertising `prototype_window_chrome_v1`. `persistence: "device"`
defaults to `bar`. `none` fills the window including under the status bar; use
`safeAreaPadding` on the top edge of a `topAppBar` or top content. Relative sheet
detents use the full window height. CtrlProxy intercepts a stationary two-finger
long press for 1 s before authored content and reveals a host dismiss pill for
5 s; single-pointer taps and swipes cannot reveal it. The host wrapper also exposes
the `Dismiss AutoMobile prototype` accessibility dismiss action without touch.
While touch exploration (TalkBack) is enabled, the pill stays visible with no
gesture or timeout. Spec opacity fades only the content, keeping the pill opaque
even at opacity 0. A CtrlProxy without `prototype_window_chrome_v1` keeps the bar,
and the host refuses explicit `none`; omitted chrome and `bar` succeed.
`lastResult.chrome` reports the effective chrome
on a successful fullscreen show and in subsequent host-local status, absent on
sheet/floating windows, dismiss, failed show and adopted prototypes.

### Frosted backdrop

Optional `window.backdrop` (#15126) is `{material, blur?, tint?}` and blurs what is behind the
window, on any placement and never the prototype's own content (that is the node-level `blur`
effect, a separate issue). The contract is conservative, one closed choice per open question:

- `material` is required and closed: `ultraThin`, `thin`, `regular`, `thick` or `glass`. `glass`
  is Liquid Glass and exists on iOS 26+ only; every other platform draws the fallback for it.
- `blur` is an optional whole-number radius in dp (points on iOS) from 0 to 150. Absent uses the
  material's own radius. Larger values are refused, as are fractions and negatives.
- `tint` is optional and one colour: a hex or a Material role, never a `{light, dark}` pair, so the
  field needs no `prototype_theme_modes_v1`.
- Where blur is unavailable (Android below API 31, cross-window blur disabled by the device or
  battery saver, a window layer that cannot blur, iOS below the material's minimum) the device draws
  a tonal fill instead of nothing: `tint` at 85% alpha, else the `surfaceContainer` role at 85%. On Android this is the only
  path below API 31; from API 31 the blur is real (`RenderEffect`), and node-level `surface: "glass"`
  (#15244, #15256) reuses that same blur and fallback.
- The field needs `prototype_backdrop_v1`. A device without it would ignore the field and draw a
  plain window, so the host refuses the show (a placement `scrim` still dims what is behind).
  CtrlProxy and the iOS prototype agent advertise it (#15126). On iOS an authored `blur` picks the nearest
  material, and Reduce Transparency draws the tonal fill.
- Android: from API 31 the window asks for blur-behind (`FLAG_BLUR_BEHIND`, radius = `blur` or the
  material's: ultraThin 8, thin 16, regular 24, thick 40 dp) when `WindowManager.isCrossWindowBlurEnabled`
  is true, with `tint` laid over it at 35% alpha. Otherwise, and always for `glass`, it draws the
  tonal fill. The reusable pieces (`PrototypeBackdrops.plan`, `Modifier.prototypeRenderBlur`, the
  tonal fallback) are what node-level `surface: "glass"` (#15244, #15256) builds on, so glass waits
  on this slice. The system layer blurring behind it has not been verified on a device yet.
- A successful show reports `lastResult.backdrop`: `blur`, or `fallback` when the tonal fill was
  drawn. It is absent without `window.backdrop`, on dismiss, on a failed show and for adopted prototypes.

## Common node properties

Every node has required `type`. All other common properties are optional:

| Property             | Shape / meaning                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | Nonempty node ID; required and unique among pagers for `pager`. Other node IDs need not be unique.                                           |
| `testTag`            | Nonempty accessibility/test selector tag.                                                                                                    |
| `contentDescription` | Nonempty accessible label read by `observe` and screen readers in place of the derived one. `{key}` state placeholders resolve as in `text`. |
| `onTap`              | Nonempty ordered array of actions, run in order. See "Tap targets" below.                                                                    |
| `style`              | Strict style object below.                                                                                                                   |
| `styleWhen`          | Conditional style overrides (see Conditional style below). One to 8 entries.                                                                 |
| `visibleWhen`        | Condition (see Conditions below). A false condition, or a missing key, means hidden.                                                         |
| `transition`         | Except on stacks (see Stack transitions), optional `none`, `fade`, `expand` or `slide`: the `visibleWhen` enter/exit. See Motion.            |
| `sharedKey`          | Optional opaque key naming this `visibleWhen` node as the same element as one other node. See Shared element morphs.                         |
| `anchor`             | Bounds or app-element anchor below.                                                                                                          |
| `safeAreaPadding`    | Explicit inset selection below.                                                                                                              |

Hidden and closed sheet content still counts toward all limits and references.
No arbitrary extra metadata is allowed.

Accessible labels: an authored `contentDescription` wins; otherwise a node is
labelled by its text, and an icon-only tappable node (or a tappable container
whose only content is one icon, such as a FAB) by its icon name. Layout
containers (`box`, `row`, `column`, `scroll`, `pager`, `spacer`, `card`) and
navigation bars are never labelled by their kind while they have content. A
layout container with no label, text, `onTap`, `testTag` or state adds no
accessibility node of its own, so its children join the nearest reporting
ancestor, as with Compose's own layouts.

Tap targets: a node with `onTap` responds across its whole drawn area, including
its own `padding`, and its accessibility bounds are that drawn area. It also
reserves a 48 dp minimum touch target, like Material components: a smaller node
keeps the size it draws at and is centered in the reserved space, which takes up
layout room.

## Nodes

| `type`            | Node-specific properties                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `box`             | Required `children` array, possibly empty; children stack. Optional `repeat` (see List templates below).                                                                                                                                               |
| `row`             | Required `children` array, possibly empty; horizontal layout. Optional `repeat` (see List templates below).                                                                                                                                            |
| `column`          | Required `children` array, possibly empty; vertical layout. Optional `repeat` (see List templates below).                                                                                                                                              |
| `text`            | Required `text` string, possibly empty.                                                                                                                                                                                                                |
| `image`           | Required opaque `asset` string; optional `contentScale`: `fit` (default), `crop`, `fill`.                                                                                                                                                              |
| `icon`            | Required built-in `name` below; optional `variant` (`filled`, `outlined`, `rounded`, `sharp`, `twoTone`).                                                                                                                                              |
| `spacer`          | No node-specific properties; size comes from style.                                                                                                                                                                                                    |
| `adaptive`        | Native-width panes and navigation; see Adaptive layouts.                                                                                                                                                                                               |
| `textField`       | Required `stateKey` naming an initialized string state value; optional `placeholder` string, default empty; `label`, `variant`, `supportingText`, `keyboardType`, `secure`, `multiline`, `minLines`, `maxLines`, `maxLength` (see Text field options). |
| `switch`          | Required `stateKey` naming an initialized boolean state value; optional nonempty `label`.                                                                                                                                                              |
| `checkbox`        | Required `stateKey` naming an initialized boolean state value; optional nonempty `label`.                                                                                                                                                              |
| `button`          | Required nonempty `label`; optional `variant`: `filled` (default), `tonal`, `elevated`, `outlined`, `text`; optional leading `icon` (built-in name). Taps run `onTap`.                                                                                 |
| `radioGroup`      | Required `stateKey` naming an initialized string state value; required `options`, 2 to 16 `{value, label}` entries with nonempty, unique `value`s.                                                                                                     |
| `listItem`        | Required nonempty `headline`; optional nonempty `supporting`, optional `leadingIcon` (built-in name), optional `trailing`: `{type: switch\|checkbox, stateKey}` bound to an initialized boolean, or `{type: icon, name}`. Taps run `onTap`.            |
| `slider`          | Required `stateKey` naming an initialized number within `min`..`max`; required finite `min` < `max`; optional `step`, optional nonempty `label`.                                                                                                       |
| `chip`            | Required nonempty `label`; optional `variant`: `assist`, `filter`, `input`, `suggestion`; optional `stateKey` naming a boolean (a filter chip only).                                                                                                   |
| `card`            | Required `children` array; optional `variant`: `filled` (default), `elevated`, `outlined`.                                                                                                                                                             |
| `iconButton`      | Required built-in `icon`; optional `variant`: `standard` (default), `filled`, `tonal`, `outlined`. Taps run `onTap`.                                                                                                                                   |
| `fab`             | Required built-in `icon`; optional nonempty `label` (an extended FAB); optional `size`: `small`, `regular` (default), `large`, only without a `label`. Taps run `onTap`.                                                                               |
| `segmentedButton` | Required `stateKey` naming an initialized string state value; required `options`, 2 to 5 `{value, label}` entries with nonempty, unique `value`s. Single select.                                                                                       |
| `topAppBar`       | Required nonempty `title`; optional `variant`: `small` (default), `centerAligned`, `medium`, `large`; optional `navigationIcon` and 1 to 3 `actions`, each `{icon, label, onTap?}`.                                                                    |
| `divider`         | Optional `orientation`: `horizontal` (default), `vertical`.                                                                                                                                                                                            |
| `badge`           | Optional nonempty `text` (a count or short label); without it a small dot.                                                                                                                                                                             |
| `progress`        | Optional `variant`: `linear` (default), `circular`; optional `stateKey` naming an initialized number within 0..`max` (determinate); optional `max` > 0, default 1, only with `stateKey`. Unbound is indeterminate.                                     |
| `chart`           | Required `variant` (`line`, `area`, `bar`, `ring`) and 1 to 4 `series` `{path, x?, y, label, color?}` over a `/data` array; optional `yRange`, `xLabels`, `goal`. See Charts.                                                                          |
| `dialog`          | Required `openWhen` and `confirm`; optional nonempty `title` and `text`, optional `icon`, optional `dismiss`, optional single `child`. Buttons are `{label, onTap?}`.                                                                                  |
| `snackbar`        | Required `openWhen` and nonempty `text`; optional `action` button `{label, onTap?}` and `durationMs` (1 to 600000, self-closing).                                                                                                                      |
| `timePicker`      | Required distinct `hourKey` and `minuteKey` naming initialized integers 0..23 and 0..59; optional `is24Hour` boolean, default the device setting.                                                                                                      |
| `datePicker`      | Required `stateKey` naming an initialized `YYYY-MM-DD` string, a real date in years 1900..2100.                                                                                                                                                        |
| `scroll`          | Required single `child`; optional `axis`: `vertical` (default), `horizontal`. Free scrolling, with no page snapping.                                                                                                                                   |
| `pager`           | Required `id` and nonempty `children` array. Each child is one page; defaults to horizontal, full-size paging. Optional `axis`, `pageSpacing`, `peek`, `pageSize` (see Pager options below).                                                           |
| `tabBar`          | Required `items`; exactly one `pager` or `stateKey`; optional `scrollable` boolean, default false.                                                                                                                                                     |
| `bottomNav`       | Required 2–5 `items`; exactly one `pager` or `stateKey`. Author positions it, typically last in a column.                                                                                                                                              |
| `bottomSheet`     | Required single `child`, `openWhen`, and `detents`; optional `scrim`, `dragHandle`, `dismissOnSwipe`.                                                                                                                                                  |

### Adaptive layouts

`adaptive` requires `prototype_adaptive_v1` and a closed `kind`. `listDetail` takes `list` and `detail` node slots plus a declared string `selectionKey`; empty string means no selection. `navigationSuite` takes 1–8 unique `{value,label}` items, a declared string `stateKey` naming an item, and `content`. `supporting` takes `main`, `supporting`, and a declared boolean `openKey`. Slots are ordinary node subtrees.

Material adaptive scaffolds use native window classes: two panes at expanded, one below; navigation uses bar/rail/drawer at compact/medium/expanded. Compact list selection shows detail; Back clears the key. There is no shared breakpoint or `minWidth`. iOS uses compact/regular, and successful shows report the difference in `platformNotes`.

Each nav item is `{label, icon?, image?}`. Label is nonempty; icon uses the same
closed list as icon nodes; image is an opaque asset ID. Both icon and image may
be supplied; the image takes visual precedence, with icon as fallback. This
counts as one image use, regardless of whether the icon fallback renders.

Pager binding (`pager: "variants"`) follows and sets that pager's local selected
page. `stateKey: "selected"` follows and sets an initialized nonnegative integer
state value. The selected value is clamped to the available item/page range by
the future renderer. Nav item count need not equal pager page count; authors
should match them when each item represents a page. Per-pager selection starts
at zero without a binding and is changed by `setPage`.

Optional `pager.stateKey` binds a declared nonnegative integer number key in both directions
(`prototype_pager_state_key_v1`). The host refuses older renderers before sending the show.
Initial and replacing-show state is authoritative; unbound pagers preserve their previous page
on same-id replacement. Settled swipes write the key and emit `page_changed` plus `change`
in one interaction. State actions and `/state/<key>` patches move the pager; integer values
clamp to the page range, with animation unless `motion: "none"`. Settling the same page is
silent. `setPage` and pager-bound navigation write the same key. A nav bar may use the same
`stateKey` (the simplest wiring). Two pagers cannot share a key, and bindings inside repeat
templates are refused at the pager's `stateKey`.

An authored indicator can live outside the pager:

```json
{
  "id": "pager-state-key",
  "window": {
    "placement": {
      "type": "fullscreen"
    }
  },
  "state": {
    "page": 0
  },
  "root": {
    "type": "column",
    "children": [
      {
        "type": "row",
        "children": [
          {
            "type": "box",
            "style": {
              "width": {
                "dp": 8
              },
              "height": {
                "dp": 8
              },
              "background": "#888888"
            },
            "styleWhen": [
              {
                "when": {
                  "key": "page",
                  "equals": 0
                },
                "style": {
                  "background": "#0066FF"
                }
              }
            ],
            "children": []
          },
          {
            "type": "box",
            "style": {
              "width": {
                "dp": 8
              },
              "height": {
                "dp": 8
              },
              "background": "#888888"
            },
            "styleWhen": [
              {
                "when": {
                  "key": "page",
                  "equals": 1
                },
                "style": {
                  "background": "#0066FF"
                }
              }
            ],
            "children": []
          }
        ]
      },
      {
        "type": "pager",
        "id": "deck",
        "stateKey": "page",
        "children": [
          {
            "type": "text",
            "text": "First"
          },
          {
            "type": "text",
            "text": "Second"
          }
        ]
      },
      {
        "type": "button",
        "label": "Next",
        "onTap": [
          {
            "type": "increment",
            "key": "page"
          }
        ]
      },
      {
        "type": "tabBar",
        "stateKey": "page",
        "items": [
          {
            "label": "First"
          },
          {
            "label": "Second"
          }
        ]
      }
    ]
  }
}
```

When a pager settles on another page the device sends one `page_changed` event whose
`name` is the pager id and whose `payload` is the new zero-based page index, the same
shape as the iOS agent (#11409). The event `pages` map still carries every pager.

`bottomSheet.openWhen` is `{key, equals}` with a **boolean** equals value. Its
state key may be absent (sheet closed); an existing value must be boolean. A
swipe dismissal with `dismissOnSwipe: true` writes `!equals` to that key, making
the condition false. Defaults: `dragHandle: true`, `dismissOnSwipe: true`. Setting
both false is permitted; the host escape remains outside author control (the
dismiss bar, or a two-finger long press on a device advertising
`prototype_window_chrome_v1`, #12064). Detents are unique values: positive `{dp: n}`,
`"half"`, or `"full"`. They preserve author order. Half/full refer to the prototype
window's height. Sheet node scrim applies inside that window, not beyond a
floating or sheet window's bounds. A modal sheet intercepts touches inside the
window while open; a sheet placement is only a window placement.

Component behavior (Material 3). Each component is one accessibility node with a native role and its label
as text, reserves a 48 dp minimum touch target, and is reached by `observe` / `tapOn` through `testTag` or
label.

- **Bound controls emit `change`.** `switch`, `checkbox`, `radioGroup`, `segmentedButton`, filter `chip`,
  `slider`, `textField`, pickers and `stateKey` selection write the bound key, emit `change` (`{key, value}`;
  `{keys, values}` for several; only when the value moved) and then run the node's own `onTap`. A `setState`
  that would make a bound value the wrong type is rejected like any binding type change.
- `button` runs `onTap`; without one it is drawn but inert. `tonal` and `elevated` are filled-tonal and
  elevated; a leading `icon` draws before the label.
- `switch` / `checkbox`: a tap anywhere, label included, flips the boolean; roles `Switch` / `Checkbox` with
  checked state.
- `slider`: the bound number must already lie within `min`..`max`; `step`, if given, must be positive and
  divide `max - min` evenly (the thumb snaps, else continuous). Dragging or an accessibility set-progress
  stores the snapped value. Reports a progress range (current, `min`..`max`, steps).
- `chip`: with `stateKey` a filter chip (toggles the boolean, `Checkbox` role); without, an assist chip
  (`Button`, runs `onTap`). `variant: filter` requires `stateKey`; `assist`, `input` and `suggestion`
  forbid it (`input` / `suggestion` only run `onTap`).
- `card`: Material container whose `children` lay out as a column; `variant` filled/elevated/outlined;
  `style.background` overrides the colour; `onTap` makes the whole card clickable; no accessibility label
  of its own.
- `radioGroup`: one radio row per option; a tap sets the string to the option `value`. A value matching no
  option leaves all unselected. Each row is a `RadioButton` node, tagged `<testTag>.<value>` when the group
  has a `testTag`.
- `segmentedButton`: like a radio group, each segment selectable and tagged `<testTag>.<value>`; single
  select only (use filter chips for multi).
- `listItem`: one node whose text is headline plus supporting line. A trailing switch/checkbox makes the row
  toggleable (`Switch` / `Checkbox` role; a tap anywhere flips the boolean, emits `change`, then runs
  `onTap`); otherwise a row with `onTap` is a `Button`, without is inert. A trailing `icon` is decorative.
- `iconButton`, `fab`: `Button` nodes running `onTap`, labelled by `contentDescription`, else an extended
  FAB's `label`, else the icon name.
- `topAppBar`: title text resolves state placeholders; navigation icon and actions are icon `Button`s
  labelled by `label`, tagged `<testTag>.navigation` and `<testTag>.actions.<index>`, each running its own
  `onTap`. It draws no system-bar inset; add `safeAreaPadding`.
- `divider` has no node unless tagged. `badge` reads as its `text`. `progress`: bound is determinate
  (`value / max` as a range over 0..1), unbound is indeterminate.
- `dialog` and `snackbar` open while `openWhen` holds (an existing key must be boolean) and draw above the
  whole author tree inside the prototype window, never as a separate window. A dialog is modal: a scrim tap
  or either button closes it; while open the page behind is removed from the accessibility tree
  (`clearAndSetSemantics`), so `observe` sees only the dialog. Closing writes `!equals` to the key and emits
  `change`, then a button runs its `onTap`. Title is its text, `text` a separate text node, `child` sits
  between text and buttons; buttons are tagged `<testTag>.confirm` / `<testTag>.dismiss`. A snackbar sits at
  the window bottom and is not modal (the page stays in the tree); it stays until closed unless
  `durationMs` (1..600000, wall-clock, not scaled by the animator) closes it by writing `!equals`. Its
  `action` (`<testTag>.action`) closes it, then runs `onTap`. Title, text and snackbar text resolve state
  placeholders.
- `timePicker`: Material dial bound to two integer keys; a change stores both and emits one `change`
  (`{keys, values}`, or `{key, value}` if one moved). `datePicker`: Material calendar bound to a
  `YYYY-MM-DD` string. Both report their value as accessibility state (`07:30` in 24-hour form,
  `2026-10-08`), move when a re-show or `setState` rebinds, and reject a `setState` that would put an
  out-of-range hour, minute or date in a bound key.

Text interpolation is a renderer concern: `{page}`, `{pageCount}`, and state
keys may appear in text. No expressions or interpolation parsing occurs during
validation. Pager context is the nearest enclosing pager; outside a pager those
two reserved placeholders remain literal. State keys `page` and `pageCount` are
permitted but the pager placeholders take precedence within a pager.

A number renders the same in a `{key}` placeholder and in a `repeat` binding (#11408),
and as the TypeScript host renders it (`renderScalar`):

- An integral number prints every digit with no decimal point and no exponent at any
  magnitude (`12345678`, `1000000000000000000000`), and negative zero prints `0`.
- Any other number prints as JavaScript's `String(number)`: the shortest decimal digits
  that read back as the same double, in plain notation down to `0.000001`
  (`0.30000000000000004`, `0.00001`) and as `<digits>e-<exponent>` below that (`1e-7`,
  `2.5e-7`). Android computes the digits itself, so the result does not depend on the
  device's `Double.toString`.

Known divergence: the iOS agent formats a non-integral number with Swift's own
description, which switches to an exponent earlier and pads it (`0.00001` shows as
`1e-05`). Integral numbers agree on all three. Prefer integral state for numbers a
prototype shows, or keep display text in a string key.

## Text field options

`textField` binds an initialized string state key. Optional `label` is a nonempty floating
label; `variant` is `filled` (default) or `outlined`; nonempty `supportingText` appears below
the field. `keyboardType` is `text` (default), `number`, `decimal`, `email`, `phone`, `url`,
or `password`. `secure` masks text; `multiline` enables multiple lines. `minLines` and
`maxLines` are integers in 1..20, permitted only with `multiline: true`; `minLines` cannot
exceed `maxLines`. Multiline text cannot use `secure: true` or `keyboardType: "password"`.
`maxLength` is an integer in 1..10000 and shows a character counter; the initial bound
value cannot exceed it (UTF-16 length).

All these options require `prototype_text_field_options_v1`. A device without the capability
is refused before uploads or show; nothing is shown. Update CtrlProxy, or relaunch the iOS
app with `launchApp prototype: true`, or drop the textField options.

`textField.errorWhen` accepts any condition form and immediately forces error styling when true, independently of `checks` and `validateOn`. Optional `errorText` requires `errorWhen` and is nonempty, at most 256 UTF-16 units. The caption is `errorText`, else the currently shown check message, else `supportingText`; with no caption the error styling still appears. Both fields require `prototype_string_conditions_v1`. Forced errors do not change validity in change events, `{valid}` or `requireValid`; those remain checks-only. A field without checks does not track blur validation.

A `textField` may also declare `trailingIcon: {icon, label, onTap?}` (a built-in icon, its
nonempty accessible `label` and optional 1-32 `onTap` actions, for example a clear button that
`setState`s the field's key to an empty string; without `onTap` it is decoration),
`imeAction` (`done`, `next`, `search`, `send` or `go`: the keyboard's action key) and
`onSubmit` (1-32 actions run when that key is pressed; without `imeAction` the key is
`done`). Multiline text has no IME action, so `imeAction` and `onSubmit` are refused with
`multiline: true`. These need `prototype_text_field_actions_v1`, with the same refusal.

Android draws `trailingIcon` as an `IconButton` (its `label` is the content description, its tag is
`<testTag>.trailingIcon`) in the field's trailing slot and maps `imeAction` to Compose
`ImeAction` with `KeyboardActions`; `next` also moves focus. iOS maps `imeAction` to `submitLabel`
and `onSubmit`, and draws the trailing icon as an SF Symbol button inside the field.

`leadingIcon` is a built-in icon name drawn in the field's leading slot (decoration, no actions; an
SF Symbol on iOS), gated by `prototype_text_field_leading_icon_v1`.

Open question: a `secure` field's value still lives in state and in `change` events/`inspect`;
this slice does not redact it.

## Style

`prototype_style_polish_v2` gates layered `style.shadows`, `style.cornerStyle`,
`style.border.gradient`, `scroll.fadeEdges` and `image.filter`. A renderer must advertise
this capability before a host sends these fields.

- `shadows` is 1–3 strict `{color, radius, spread?, offset?, inner?}` entries. Radius is
  0–1000 dp, spread and each offset axis are -1000–1000 dp. Omitted spread is 0,
  omitted offset is `{x:0,y:0}`, and omitted inner is false. Layers paint in array
  order within the outer and inner groups: first is bottom-most, later layers sit on top.
  Blur radius `b` uses Gaussian sigma `b/2` (CSS-like blur). Android adapts this to
  the platform blur filter, whose minimum nonzero sigma is approximately 0.5 px.
  `color` takes the same hex, role or `{light,dark}` forms as `shadowColor`. `shadows` excludes both
  `elevation` and `shadowColor`, including explicit zero elevation.
- `cornerStyle` is `circular` (default) or `continuous`, including with `cornerRadius: "full"`.
  Continuous corners use dependency-free cubic smoothing (approximately 0.6), tapering
  to circular at half the short side so full radii remain valid pills/circles.
- A border is strict `{width, color?, gradient?}`, with exactly one of `color` or
  `gradient`. Gradient reuses the linear/radial background-gradient contract.
- A scroll node's `fadeEdges` is strict `{top?, bottom?, start?, end?}`, with at least
  one edge, each 0–1000 dp. Fades draw only on edges that can still scroll; start/end
  mirror in RTL. Top/bottom apply only to vertical scrolling, start/end only to horizontal
  scrolling. Each fade is capped to its viewport dimension.
- An image node's `filter` is strict `{saturation?, tint?}`, with at least one field.
  Saturation is 0–2 and tint is a colour value. Saturation applies first, then tint
  multiplies the image channels (including alpha). Other node types cannot set filter.

Pairs in shadows and image tint, and pairs or role names in border gradient stops,
also require `prototype_theme_modes_v1`.

Rendering order: transform, press scale, size, alpha, drop shadows (`shadows`/`elevation`
draw before the clip), clip (`cornerRadius` + `cornerStyle`), background, gradient,
shimmer, border (color or gradient), inner shadows.

All properties are optional. Sizes, padding, offsets, radii, and spacing use dp.
Numeric lengths are capped at 10000, including fixed dimensions, bounds x/y/width/height,
size constraints, padding, corner radii, border width, spacing, sheet height and fixed detents.
Offsets and bounds x/y range from -10000 to 10000. Elevation is capped at 1000; text size and line height
are positive and capped at 1000, and letter spacing ranges from -1000 to 1000.
Weight and aspect ratio range from 0.000001 to 10000. All endpoints are inclusive.

Text size uses sp, so it follows the system font scale. Negative offsets/positions
are allowed; sizes are nonnegative, except text size and sheet height/detent
height which must be positive. Positive values use a minimum of 0.000001.

| Property                                         | Accepted value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `width`, `height`                                | `"fill"`, `"wrap"`, or strict `{dp: n}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `weight`                                         | Positive number. A `row`/`column` child fills the remaining main-axis space in proportion to its weight (ignored elsewhere).                                                                                                                                                                                                                                                                                                                                                                                       |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | Nonnegative dp bounds applied after `width`/`height`, so `fill` and `{dp}` are clamped by them.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `padding`                                        | Strict `{top?, bottom?, start?, end?}`, each nonnegative dp; omitted edges are zero.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `background`, `color`                            | Strict hex color, or a Material 3 color role name (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cornerRadius`                                   | Nonnegative dp, a Shapes token (`none`, `extraSmall`, `small`, `medium`, `large`, `extraLarge`, `full`), or strict per-corner `{topStart?, topEnd?, bottomEnd?, bottomStart?}` of nonnegative dp where an omitted corner is square. Start and end follow the layout direction.                                                                                                                                                                                                                                     |
| `border`                                         | `{width, color?, gradient?}`; nonnegative dp width; exactly one paint source, a colour value or a linear/radial gradient.                                                                                                                                                                                                                                                                                                                                                                                          |
| `elevation`                                      | Nonnegative dp. Draws a shadow in the node's corner shape, behind its clip, background and border.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `shadowColor`                                    | Hex color or color role name tinting the `elevation` shadow (ambient and spot). Without `elevation` it draws nothing; absent, the platform shadow color applies.                                                                                                                                                                                                                                                                                                                                                   |
| `gradient`                                       | `{type: "linear", angle, stops}` or `{type: "radial", stops}`. `angle` is a finite number of degrees clockwise from left-to-right (0 = left to right, 90 = top to bottom). `stops` is 2–4 `{color, position?}` with a hex color and an optional 0–1 `position`; positions apply only when every stop has one (a position below the previous stop's is raised to it), otherwise stops are evenly spaced. Radial gradients are centered and reach the corners. Painted over `background` in the node's corner shape. |
| `aspectRatio`                                    | Positive number (width / height) applied after the size bounds.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `offset`                                         | Strict `{x, y}` dp, negative allowed. Shifts the drawn node, its shadow, touch target and accessibility bounds without moving siblings: the node keeps its layout slot.                                                                                                                                                                                                                                                                                                                                            |
| `alpha`                                          | Finite number 0–1; default 1. Multiplies window opacity.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pressScale`                                     | Finite number 0.5–1. A node with a plain `onTap` (box, row, column, text, image, icon, spacer) scales to this while pressed and back on release; absent leaves it unscaled. Instant, not animated, when `motion` is `none` or the system animator duration scale is 0; iOS also snaps under Reduce Motion. Component nodes (button, chip, switch, ...) keep their own press feedback and ignore it.                                                                                                                |
| `alignment`                                      | `topStart`, `topCenter`, `topEnd`, `centerStart`, `center`, `centerEnd`, `bottomStart`, `bottomCenter`, `bottomEnd`.                                                                                                                                                                                                                                                                                                                                                                                               |
| `arrangement`                                    | `start`, `center`, `end`, `spaceBetween`, `spaceAround`, `spaceEvenly`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `spacing`                                        | Nonnegative dp between row/column children; arrangement remains authoritative for distributed free space.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `textSize`                                       | Positive sp; scaled by the system font scale.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fontWeight`                                     | Integer 100–900.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `textAlign`                                      | `start`, `center`, `end`, `justify`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `maxLines`                                       | Integer 1–2147483647.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `overflow`                                       | Text past `maxLines` or its width: `clip` (default), `ellipsis` or `visible`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lineHeight`                                     | Positive sp between baselines; scaled by the system font scale.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `letterSpacing`                                  | Finite sp added between letters; negative tightens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `textDecoration`                                 | `none`, `underline`, `lineThrough` or `underlineLineThrough`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fontStyle`                                      | `normal` or `italic`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fontFamily`                                     | A system name (`default`, `sansSerif`, `serif`, `monospace`) or `{asset: "<id>"}` naming an uploaded TTF/OTF font (#10443).                                                                                                                                                                                                                                                                                                                                                                                        |

The text properties (`textSize`, `fontWeight`, `textAlign`, `maxLines`,
`overflow`, `lineHeight`, `letterSpacing`, `textDecoration`, `fontStyle`,
`fontFamily`, `textStyle`) style `text` nodes. An unset `fontStyle`,
`textDecoration`, `lineHeight` or `letterSpacing` keeps what the `textStyle` role
or the theme supplies.

Colors accept `#RRGGBB` or `#AARRGGBB`, with case-insensitive hex digits, or one
of the Material 3 `ColorScheme` role names (`primary`, `onPrimary`,
`primaryContainer`, `secondary`, `tertiary`, `background`, `surface`, `onSurface`,
`surfaceVariant`, `surfaceContainer` and its `Low`/`High`/`Highest`/`Lowest`
steps, `surfaceBright`, `surfaceDim`, `error`, `outline`, `scrim`, and the rest
of the scheme, 36 in all). A role resolves against the prototype's active theme
(`theme.mode`, `colors.seed`, device colour, `colors.<role>` overrides), so it follows light/dark and the
seed. No short hex, other named colors, CSS functions, or separate color opacity. Style
properties that do not apply to a node have no rendering effect; their shape is
still validated. Omitted layout/text properties use Compose/system defaults.
Start/end use layout direction, including RTL.

### Pager options

Any explicit `axis`, `pageSpacing`, `peek` or `pageSize` requires
`prototype_pager_options_v1`; an older device is refused before anything is shown,
even for explicit default values. Omission keeps existing behaviour.

- `axis`: `"horizontal"` (default) or `"vertical"`.
- `pageSpacing`: finite dp gap, 0..10000 (default 0).
- `peek`: strict `{start?: number, end?: number}`, each finite dp in 0..10000,
  exposing neighbouring pages along the main axis. Missing sides default to 0;
  `{}` is accepted as a no-op.
- `pageSize`: `"fill"` (default) or strict `{dp: number}`, finite 1e-6..10000,
  allowing several pages per viewport. The shared limit is `MAX_PROTOTYPE_PAGER_DP`.

A vertical pager cannot have any vertical scroll ancestor (omitted scroll axis is
vertical), even through intervening containers or horizontal scrolls. A vertical
pager inside only a horizontal scroll is valid; horizontal pagers stay valid.
The error is at the pager's `.axis`: "A vertical pager cannot appear inside a vertical scroll".

The horizontal counterpart (#14165): a horizontal (or default-axis) pager or a carousel cannot have
any horizontal scroll ancestor, because a horizontal scroll measures its child with an infinite
width that their lazy layouts cannot take. The errors are at the pager or carousel itself: "A
horizontal pager cannot appear inside a horizontal scroll" and "A carousel cannot appear inside a
horizontal scroll".

Current page means the first fully visible page: fixed sizes snap at Start; fill
uses the usual settled page. `page_changed`, `{page}` / `{pageCount}`, `setPage` and
navigation pager bindings keep their meaning. Stable keys and neighbour retention
stay unchanged. Every visible page (including partly visible peek and fixed-size pages) is exposed to accessibility, observe and tapOn; Android marks the current page selected only for pagers with positive peek or a fixed pageSize; iOS marks it selected on the options path (a pager with any non-default option) and not on the legacy paged pager; plain pagers expose only the current page on both. Pages fully off-screen are not exposed. Indicator and carousel remain deferred. On iOS dp means points.

## Icon effects

An `icon` accepts `effect: {type, trigger?, repeat?}` under
`prototype_icon_effects_v1`. `trigger` is exactly `{key: "stateKey"}` or
`{data: "/pointer"}` and replays once when that value changes. Keys are literal
state keys. Omit both controls for one play on appearance. `repeat` is
`"infinite"` or an integer 1–20; trigger and repeat cannot coexist. `replace`
reacts to `name` changes. Scale holds at 1.15 while its trigger is truthy
(false, null, missing, zero and empty string are false).

| Type          | iOS native effect and minimum OS | Android approximation                  |
| ------------- | -------------------------------- | -------------------------------------- |
| bounce        | bounce, 17                       | scale 1 → 1.2 → 1                      |
| pulse         | pulse, 17                        | alpha 1 → 0.4 → 1                      |
| scale         | scale.up, 17                     | scale to 1.15 while trigger is truthy  |
| variableColor | variableColor, 17                | alpha sweep                            |
| wiggle        | wiggle, 18; bounce on 17         | rotation ±10°                          |
| rotate        | rotate, 18; no effect on 17      | rotation 0 → 360°                      |
| breathe       | breathe, 18; pulse on 17         | scale 1 → 1.06 with alpha              |
| replace       | symbol replace, 17               | crossfade with scale when name changes |
| drawOn        | drawOn, 26; replace on older OS  | crossfade                              |

Reduced and off profiles keep icons at rest, except reduced `replace` uses a
plain crossfade. Repeated effects count as loops in the motion signal and share
the eight animated-effect budget, including expanded repeat instances. During
Android capture, repeated effects rest so successive captures use the same pose.
Successful shows report Android approximations and iOS version fallbacks in
`platformNotes` at the icon's `.effect` path; when discovery has no OS version,
notes describe the conditional fallback explicitly.

The iOS `hide_for_capture` hold removes repeated symbol modifiers, returning icons to
rest until the last capture token releases or expires. Restoring restarts native
repeats. Local `PrototypeIconMotionActivity` tracks mounted repeated effects and
masks activity during capture; finite native repeats remain conservatively active
until unmounted because SF Symbols provides no completion callback. iOS has no
shared motion-active wire signal or shimmer reporter yet; this local signal is
not exposed to the host, and captures that bypass `hide_for_capture` do not rest effects.

Android currently uses a self-contained Compose animation with 600 ms cycles;
this should move onto the #15249 keyframes engine when it is available.

## Icons and images

Built-in names are the 2,075 icons of `material-icons-extended` in snake_case (`home`, `alarm_add`); the
closed list is the `iconName` definition in `schemas/prototype-spec-contract.json`, shared by both
validators. The renderer already ships that library, so the set adds only the list (about 10 KB). An icon
node may set `variant` (`filled` default, `outlined`, `rounded`, `sharp`, `twoTone`); nav items are always
filled. Material Symbols names without a counterpart and symbol `weight` / `fill` axes (which need a bundled
variable font) are unavailable. Custom text fonts ship as host-uploaded assets (see "Custom fonts").

Unknown names reject the spec. Images are ID-based (#9301): `{type: "image", asset: "opaque-id"}` and nav
`image: "opaque-id"`. Existence is not validated at spec level; a missing asset renders a placeholder and is
reported in `missingAssets`. Bytes, MIME types, URLs, cache paths and screenshot handles are not spec
properties.

### Asset transport (#9301, first slice)

`put_prototype_asset {id, mimeType, dataBase64}` uploads one asset and
`remove_prototype_asset {id}` deletes one; each gets one `prototype_result` carrying the
request ID. Bytes travel as base64 in the single JSON text frame, like screenshots.
Heap, not the 64 MiB frame limit, is the binding constraint, so caps are
conservative and shared with the host through `schemas/prototype-asset-contract.json`:
4 MiB per asset, 32 assets, 16 MiB total, ids of 1 to 256 characters, and
`image/png`, `image/jpeg` or `image/webp` (exact lowercase) whose bytes must start
with the matching signature, plus `font/ttf` and `font/otf` (2 MiB each, see Custom fonts). Putting an existing ID replaces it; a full store rejects
the put with a clear error and never evicts. Removing an unknown ID succeeds. Assets
sit in the CtrlProxy cache directory and are cleared when the prototype session ends:
on any dismissal, on service start, unbind or teardown, on `dismiss_prototype` with
`all`, and when the last client disconnects (even with no prototype showing). A show
replacement and a temporary lock-screen hide keep them.

### Custom shader assets

`application/vnd.automobile.agsl` assets carry UTF-8 AGSL source, capped at `MAX_PROTOTYPE_SHADER_ASSET_BYTES = 16384`. Upload a local `.agsl` file through `assets: [{id, path}]`, then reference its id with `style.shader: {asset, uniforms?}` (also accepted in `styleWhen`). The host refuses uploads and shader specs unless `AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1`; the Android runtime must advertise `prototype_custom_shaders_v1`. Shader assets share the existing count and total-byte limits. Available assets must have the AGSL MIME type and every supplied uniform must be declared as a scalar float in that source. iOS (including simulator saves) and ProtoViewer bundles refuse custom shaders. Native host export refuses shader specs on both platforms until the generated hosts support shader assets.

The Android runtime advertises `prototype_custom_shaders_v1` only on API 33+. It compiles on `put_prototype_asset` before writing any source; unsupported APIs return a typed refusal naming API 33, and invalid source returns the compiler message capped at 2048 UTF-8 bytes without splitting a character. Failed replacements preserve the previous asset. Device lexical preflight restricts inputs to scalar floats and the node's own `content`; show/patch validation checks every style alternative and hidden descendant against device-compiled scalar declarations, and per-node compilation rechecks all supplied names before setting any values, clamps finite values to [-1000000, 1000000], and gives each node an independent shader instance. Procedural sources without a content declaration receive an unused `uniform shader content;` so the same RenderEffect path can bind the node's content.

Embedded applications supply AGSL bytes through `PrototypeAssets.withShaders` and its optional shader resolver; image and shader lookups use separate typed namespaces even when ids collide. These sources receive the same lexical, UTF-8 and compiler validation before rendering. Each composed node owns its compiled shader, reused across uniform changes and recompiled when its source asset or version changes. Removed float uniforms reset to zero. Compiler diagnostics refer to authored source lines, accounting for the injected content declaration. Each node applies its shader through a clipped Compose graphics layer using `createRuntimeShaderEffect(shader, "content")`. Content remains unshaded while preparation runs, while an asset is missing/unreadable, or on API levels below 33. Missing shader assets follow the existing missingAssets warning/re-upload path and retry on asset changes.

One session-level frame-clock loop runs only while at least one visible shaded node is composed (excluding settled-hidden retained subtrees) and the prototype lifecycle is RESUMED; the control-proxy pauses that lifecycle while hiding its window for capture. Only the newest composed window root owns sampling during a window replacement; retiring an older root cannot hide or pause the new one, and a failed replacement restores the older root. Gaps discard the first interval after resuming without clearing budget evidence. All shaders in the prototype are permanently disabled after 8 consecutive intervals strictly above 24 ms, or more than 30 slow intervals in the last 60 sampled intervals. Intervals at or below 24 ms reset only the consecutive streak; duplicate/backwards timestamps are ignored. Status lists this once as `frame budget exceeded while shaders were active`: it measures whole frame intervals and cannot attribute the delay to a shader. A static expensive shader without fresh frame work cannot be measured, and asynchronous RenderThread/GPU faults cannot be caught.

Synchronous compile/effect/draw exceptions disable only the affected composition instance. Duplicate repeat identities have separate guards; disposed registrations are evicted. `get_prototype_status` reports at most 64 node failures with unique instance ids and bounded reasons, plus a `+N more` summary, in optional `shaderFailures`; host `inspect` adopts these into the next host-local `status`. An in-place show preserves the session budget and recorded failures; dismissal or an explicit reset starts a new lifetime. A remounted node gets a fresh instance guard, while a tripped session budget continues to disable all shaders.

The wire protocol has no host opt-in channel. The existing host gate `AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1` therefore remains the authorization boundary; capability advertisement alone does not enable the host to send shaders. Direct device clients are responsible for the same opt-in policy.

`needs-device-verify`: real API 33+ compilation and rendering, procedural sources with an unused content input, isolation of each node's sampled content and uniforms, shader output clipped to node bounds, lifecycle/background and capture-hide sampling gaps, frame-budget fallback under sustained and spaced load, and status/inspect reporting after a real rendering failure remain unverified on a device. JVM tests use fake compilers and frame clocks and establish no GPU/rendering proof.

### Device media items (#14192, contract only)

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
  shared corpus (`media-*` fixtures) are in; the device stores, EXIF handling, the read-only
  `prototype {action: "media"}` host action and the `mediaItems.inject` simulation follow, so no
  renderer advertises it yet and the host refuses a show that uses it.

### Rendering assets (#9301, second slice)

An `image` node draws its asset with `contentScale`: `fit` letterboxes, `crop` fills the box and clips, `fill` stretches. Bytes are decoded off the main thread with `BitmapFactory` and `inSampleSize`, downsampled to the node's laid-out size (screen size when an axis wraps) and never above 4 Mi pixels. The decoded-bitmap cache keys on asset id and a power-of-two size bucket, evicts least recently used first and holds at most 32 MiB of decoded pixels (a larger single bitmap is drawn but not retained). A replaced, removed or cleared asset drops its decoded copies immediately and showing nodes reload; uploading a previously missing id fills the placeholder.

A nav item draws its `image` when ready, then its built-in `icon`, then a gray square. While an image decodes the node shows a plain gray box; an unknown id, a file the OS evicted from the cache directory (the store lists it but `read` returns null) or undecodable bytes renders a gray box with a broken-image glyph.

`show_prototype` lists referenced ids the device has no copy of in `prototype_result.missingAssets`, in first-use order. It is a warning: `success` stays true and placeholders show, so the host can upload and the nodes fill in without another `show`. The field is omitted when nothing is missing and from every other result. An id the store lists but whose file was evicted is not reported at `show`; it renders the placeholder.

Host surface: the `prototype` tool's `show` takes
`assets: [{id, path}]`, an absolute daemon-readable file path per asset. The host
reads and validates every file first (signature-detected MIME type, the contract
limits, unique ids), then uploads sequentially before the prototype request; any
failure fails the call before the prototype changes and names the assets already
stored. An entry may instead be `{id, observation}`, an
`automobile:observation/{deviceId}/{observationId}/screenshot` URI; the host reads it
through the same handler as that resource (current-observation check, pending-capture
wait, retention lease), which is readable by any client, so no access is widened.

When `prototype_result.missingAssets` lists an id the same call uploaded (the device
cleared its store between the upload and the show), the host re-uploads those assets
once from the bytes it already holds and re-sends the show once. It never
loops: if they are still missing, or the retry fails or is cancelled, the first
successful result is returned with `missingAssets` and a `warning` on the tool output.
Ids the call did not supply are only reported. See `docs/tools.md` for the result and
deadline model.

### Custom fonts (#10443)

`style.fontFamily` also accepts `{asset: "<id>"}`, an opaque id of a font uploaded through
the same asset pipeline as images (`put_prototype_asset`, or `assets: [{id, path}]` on the
host). The spec carries only the id; font bytes, MIME types and caps stay out of it.

- Transport: `font/ttf` and `font/otf` join the contract's MIME types. The bytes must start
  with an sfnt version tag, `0x00010000`, `true` or `OTTO`, accepted for either MIME type
  because an OpenType file may carry TrueType outlines. TrueType collections (`ttcf`) and
  WOFF are rejected. Fonts are never decoded as images. The per-font cap is 2 MiB
  (`MAX_PROTOTYPE_FONT_ASSET_BYTES`); fonts count toward the 32-asset and 16 MiB totals
  like images. The host detects a font from the file signature, not the extension.
- Missing assets: a referenced font the device has no copy of is listed in
  `prototype_result.missingAssets` with the image ids (references in `style` and `styleWhen`
  count, including hidden nodes) and the text draws in the default family until it is
  uploaded.
- Rendering: the font is loaded from the stored asset file with `FontFamily(Font(file))`,
  once per asset, and cached. A file that cannot be parsed logs one warning and draws
  with the default family; the prototype is never failed for it. Replacing an asset reloads
  it; removing it (or ending the session) while a spec still references it falls back to
  the default family, the same as a removed image becoming a placeholder.
- Weights: one file is one face, so `fontWeight` selects that face rather than a bolder
  one. Upload a font file per weight and use `styleWhen` to choose between them.

## Motion

Text nodes accept `contentTransition: "numeric" | "crossfade" | "none"` (default `none`). Non-`none` requires `prototype_content_transition_v1`. Numeric changes roll only changed characters up for an increase and down for a decrease; formatting is stripped to digits, the first decimal point and a leading minus. Missing or equal numeric values crossfade; identical text stays still. Spans crossfade as a whole. Roll uses a spring (Android damping 0.8, stiffness 380; iOS duration 0.35 s, bounce 0.15); fades take 200 ms. Accessibility and observe expose the new text immediately. Android reduced motion uses fades and motion off snaps; iOS content transitions snap under reduced motion or motion off.

`scrollTransition: {axis, edge: {scale?, alpha?, rotation?}}` on a descendant
of a scroll, pager, carousel or repeat interpolates from the authored edge values
to identity at the viewport center. `axis` is `horizontal` or `vertical`.
`scrollLinked: {source, range: [start, end], alpha?, scale?, offsetY?, offsetX?, blur?}`
uses the offset in dp of a scroll with that `id` in the same stack screen. The
input endpoints increase; each output is a pair that may increase or decrease.
Values interpolate linearly and clamp outside the input range. At least one
output is required. Alpha is clamped to 0–1 and blur to a nonnegative radius. Android blur requires Android 12 or later.
Both fields require `prototype_scroll_motion_v1`; each counts as one binding,
with at most 16 bindings after component and repeat expansion. These are drawing
transforms: layout slots, hit targets and reported bounds stay fixed. The
`reduced` profile keeps alpha and drops scale, rotation, offsets and blur;
`none` retains all scroll-driven outputs because they follow position, not time.

Prototype state changes animate by default (#10442). A node with `visibleWhen`
fades and expands in and fades and shrinks out; a pager page change driven by
`setPage` animates the scroll instead of jumping. Spec-level `motion: "none"`
opts out and keeps every change instant. Motion is also off when the system
animator duration scale is 0 (`adb shell settings put global
animator_duration_scale 0`), so `observe` screenshots are settled with no
extra waits; other scales are honored by Compose's animation clock. The scale is
observed while the prototype is shown, so setting it to 0 after the prototype is up
makes the next visibility or page change instant, and turning motion off
mid-scroll snaps the pager to its target page. Only nodes with `visibleWhen` get
an animation wrapper.

`box`, `row` and `column` containers animate their size when their children
appear, disappear or change (`animateContentSize`), gated by the same
motion-enabled check, so a sibling slides into the freed space instead of
jumping.

A non-stack node's optional `transition` picks the `visibleWhen` enter/exit: `none`
(instant), `fade`, `expand` (grow/shrink) or `slide` (vertical slide with a
fade). Absent keeps the default fade + expand. It has no effect on nodes
without `visibleWhen`, or when motion is off; a show reports the advisory
`transition-without-visible-when` accessibility finding for that case.

A style `pressScale` (0.5–1) shrinks a tappable node while it is pressed. With
motion on it animates with a short spring; with `motion: "none"` or animator
scale 0 it snaps, so a screenshot taken mid-press is still deterministic.

### Expressive and layout motion (`prototype_motion_v3`)

`motion: "expressive"` selects Material 3 expressive springs. Standard remains the default.

| Change                                                      | Expressive spring |
| ----------------------------------------------------------- | ----------------- |
| Visibility size, offset, scale; container size; press scale | Default spatial   |
| Visibility alpha; press alpha; animated color and alpha     | Default effects   |

Node `animate` also tweens `border.color`, `border.width`, `cornerRadius`, `elevation`,
`shadowColor`, `padding`, and dp `width`/`height`. Its duration and easing apply as before;
`easing: "spring"` uses the expressive spring when expressive motion is selected. Text, font,
gradient and fill/wrap/token swaps remain instant.

Node `press: {scale?, alpha?}` requires at least one field: scale 0.85–1, alpha 0.5–1.
It requires tap/long-press/double-tap actions or an inherently pressable control (button,
iconButton, fab, chip, listItem, switch, checkbox, radioGroup, segmentedButton, select or menu).
`press.scale` overrides `style.pressScale`. Feedback changes drawing only, keeping the 48dp
minimum touch target and reported bounds. Component gestures remain owned by their controls.

With `motion: "none"` or animator scale 0, style changes and control state visuals are instant,
and clickable nodes and Material controls draw no ripple. Material boolean controls are keyed
by their final state while off to avoid starting their internal animations; slider position is
immediate and its thumb uses a resting interaction source. Reduced motion still snaps spatial
changes and preserves fades and colors.

### Window and modal motion

Android `prototype_window_motion_v1` gates authored `window.transition` and
`repeat.stagger`. Window transitions are `auto` (default), `none`, `fade`, `slide`,
or `scale`. Auto slides a sheet from its placement edge, fades and scales a
floating surface from 0.92 to 1, and fades fullscreen content. Exit mirrors enter.
Same-id shows update the existing window when motion is off or the incoming
transition is `none`, preserving focus and keyboard attachment. With full or
reduced motion and an animated transition, replacement attaches a new window
while the outgoing window exits; focus transfers to the new window. Changes to
display, layer or surface id also require a new window regardless of motion.
Root Compose content animates for 300 ms; removal is scheduled through the host
settle timer at 400 ms, independent of animation frames. Exiting windows become
non-touchable immediately. Outgoing windows retain their hierarchy motion metadata
and shared image/font assets until detach; service teardown drains these exits
immediately. Dismissal events and sequence allocation retain their
existing timing at exit start. Agent shows animate; device-persistence boot
restoration does not. Idle TTL, last-client disconnect and service teardown remove
windows immediately to keep teardown bounded.

Bottom sheets slide from the bottom, dialogs and menus fade and scale, and
snackbars fade and slide. Scrims fade with their surfaces. Panels remain composed
through exit, including when removed from the authored tree; a patch reopening a
panel cancels its exit and re-enters. `SheetDismiss` and modal button actions commit
at exit start, so runtime state and emitted action events change immediately;
retained visual content finishes exiting afterward with input disabled and its
semantics cleared. A dragged sheet follows the
pointer directly and springs to the selected detent on release. Reduced motion
uses fades without translation, scaling or detent springs. Off motion snaps and
keeps the settled rendering unchanged. Window and modal transitions and detent
settles participate in the motion-active signal, following the conventions of
#15114 (see Motion-active signal): the surface reports itself through
`ReportPrototypeMotion` while an exit or settle runs, so `observe` never captures it mid-flight.

`repeat.stagger` is an integer 0–100 ms per instance, in item order. Only template
children with `visibleWhen` receive it. It adds to container stagger and transition
delay through the existing enter-delay machinery, with each total capped at
600 ms; exits are not delayed.

Test-budget note: the repository's 100 ms per-test unit budget is measured only from bun's JUnit
reporter (`scripts/test-ts.sh`, `scripts/validate-bun-test-timings.sh`). It does not cover Gradle or
Robolectric tests, so the Compose and host tests for this feature are not held to it. iOS accepts the structural contract but does not
advertise this capability, so host preflight refuses either authored field.

### One-shot keyframes

Every node may carry `keyframes: {trigger, durationMs, tracks}`, gated by
`prototype_keyframes_v1`. The trigger is exactly one declared state `{key: "liked"}`
or a data pointer `{data: "/liked"}` relative to the data object. A value change plays
once; mounting does not play, and a change during playback restarts from zero.

`durationMs` is an integer from 100 to 3000. Tracks contain one to seven of `scale`,
`scaleX`, `scaleY`, `rotation` (degrees), `offsetX`, `offsetY` (dp), and `alpha`.
Each is 2–8 `[fraction, value]` points or `{points, curve?}`; fractions increase strictly
from 0 to 1. Curves are `linear`, `standard` (default, cubic Bezier 0.2,0,0,1), and
`spring`. Scale values are positive and alpha stays in 0–1. Both ends equal rest:
1 for scale and alpha, 0 for rotation and offsets. The first node beyond the expanded
16-node budget fails at its `.keyframes`, including component and repeat instances.

One Compose `Animatable` drives draw-time layers, composing scale/alpha multiplicatively
and rotation/offsets additively with style motion. Tracks do not change layout or authored
semantics. Reduced motion drops spatial tracks and retains alpha; off disables playback.
Finite playback contributes to the motion-active signal. The pure spring sampler uses a
normalized damped ease derived from damping ratio 0.8 and stiffness 380, with exact endpoints.
iOS runs one linear `KeyframeAnimator` phase per track and applies the same sampler as Android, so all three curves match across platforms. A `trigger.key` is a plain declared state key, not a per-row bound key, so every repeat instance plays on the same trigger; per-row triggers need a bound-key form and are not part of v1.

### Motion profiles (#15115, `prototype_reduced_motion_v1`)

Motion runs in one of three profiles, decided identically on both platforms from the spec's
`motion` and the system setting:

| Profile   | Chosen when                                                                                                            | Behaviour                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`    | Neither of the rows below applies.                                                                                     | Every animation described in this section.                                                                                                                                                                                                    |
| `reduced` | `motion: "reduced"`, or on iOS system Reduce Motion.                                                                   | Spatial animations (slide, expand and shrink, scale, container size, `pressScale`, swipe-row and stack slides, shared element morphs) become crossfades or snap. Loops (shimmer, indeterminate progress) rest. Color and alpha still animate. |
| `off`     | `motion: "none"`, or on Android animator duration scale 0 or transition animation scale 0 (read from Settings.Global). | Everything is instant.                                                                                                                                                                                                                        |

`none` wins over `reduced`, and a system `off` wins over both. Android has no system reduced
setting, so there `reduced` comes from the spec alone; both scales are observed while the prototype
is shown. On iOS the system Reduce Motion setting selects `reduced` rather than `off`, so a Reduce
Motion run shows crossfades; `motion: "none"` is still fully instant. `motion: "reduced"` needs
`prototype_reduced_motion_v1`, which the host checks before showing.

### Shared element morphs (#15115, `prototype_shared_element_v1`)

`sharedKey` names two `visibleWhen` nodes as one element, so swapping them morphs the first into
the second (a list row into a detail card, a thumbnail into a viewer):

```json
{
  "state": { "open": false },
  "root": {
    "type": "box",
    "children": [
      {
        "type": "row",
        "sharedKey": "album",
        "visibleWhen": { "key": "open", "equals": false },
        "onTap": [{ "type": "setState", "key": "open", "value": true }],
        "children": [{ "type": "text", "text": "Album" }]
      },
      {
        "type": "card",
        "sharedKey": "album",
        "visibleWhen": { "key": "open", "equals": true },
        "onTap": [{ "type": "setState", "key": "open", "value": false }],
        "children": [{ "type": "text", "text": "Album" }]
      }
    ]
  }
}
```

A literal key referenced as a zoom source labels exactly one node and is exempt from the
`visibleWhen` requirement and visibility-pair counting.

Rules, enforced by every validator with exact paths: `sharedKey` retains the state-key grammar
and aliases `shared: {key, as: "bounds"}`. The object form requires
`prototype_shared_element_v2`; plain `sharedKey` requires `prototype_shared_element_v1`.
A node cannot set both. Visibility morph nodes must have `visibleWhen`. Literal v2 keys allow hyphens in addition
to the state-key characters, with a 64-character resolved limit. Literal visibility morph keys pair exactly two
nodes. Inside repeat children, a key template must reference the field named by `repeat.key`,
without index or other-field placeholders. Each instance must resolve a distinct key; at most
two nodes can use each resolved key. Unmatched repeat items remain ordinary cards. A spec has
at most 16 resolved keys for visibility morphs, including unmatched feed items. Pairs cannot nest, disagree on `as`, or cross a `dialog` or `bottomSheet`
boundary (including two separate modals). Shared elements across pager pages and `stack` screens
are not supported.

Under `full`, Android applies `sharedElement` for `as: "element"` (identical content, only the target
draws) and `sharedBounds` for `as: "bounds"` (changing content, both sides crossfade), in one
`SharedTransitionLayout`. iOS uses `matchedGeometryEffect(properties: .frame)` in one namespace;
bounds also crossfades the two sides. The morph counts in the motion-active signal. Under
`reduced` both kinds crossfade in place; under `off` they swap instantly. A pair visible at the
same time keeps ordinary visibility behavior. Shape interpolation still needs `animate` on
`cornerRadius`; image content scale snaps.

A feed card expanding into a detail column uses the same spec on Android and iOS. Here the one
feed item binds `story-{item.id}` to `story-one`; tapping it swaps the pair. More feed items may
have unmatched keys until their corresponding detail is shown.

```json
{
  "window": { "placement": { "type": "fullscreen" } },
  "state": { "open": false },
  "root": {
    "type": "box",
    "children": [
      {
        "type": "column",
        "repeat": { "items": [{ "id": "one" }], "as": "item", "key": "id" },
        "children": [
          {
            "type": "card",
            "shared": { "key": "story-{item.id}", "as": "bounds" },
            "visibleWhen": { "key": "open", "equals": false },
            "onTap": [{ "type": "setState", "key": "open", "value": true }],
            "style": { "width": { "dp": 160 }, "height": { "dp": 80 } },
            "children": [{ "type": "text", "text": "Story {item.id}" }]
          }
        ]
      },
      {
        "type": "column",
        "shared": { "key": "story-one", "as": "bounds" },
        "visibleWhen": { "key": "open", "equals": true },
        "onTap": [{ "type": "setState", "key": "open", "value": false }],
        "style": { "width": { "dp": 320 }, "height": { "dp": 400 } },
        "children": [{ "type": "text", "text": "Story one: the full detail" }]
      }
    ]
  }
}
```

### Motion-active signal (#15114)

Fades and scales change no node, so two identical hierarchy reads do not prove a
prototype has stopped moving. The prototype window's entry in a hierarchy capture
carries `prototypeMotion: {active, loops}` next to `prototypePlacement`
(`prototype_window_metadata_v1`; older APKs omit it and hosts read absence as
settled). `active` counts the animations that will finish: `visibleWhen` and
retained-visibility transitions, `animate` style animations, `pressScale`,
container size changes, swipe-row settles and pager scrolls. `loops` counts
intentional infinite animations (today only the shimmer) and is ignored by hosts.
`observe(waitFor: stable)` and the launcher/SystemUI quiet-tree wait do not settle
while `active` is positive and stay bounded by their usual timeout. The count is
zero after a single frame under `motion: "none"` or animator scale 0.

### Screen map (#14125)

`prototype {action:"screenMap", spec | specPath}` is host-only (no device request). It walks the
spec, after component expansion, and returns `screenMap {nodes, edges}` plus a `mermaid` flowchart.
Nodes are the root, each `stack` screen (`stack:<id>/<screen>`, `start` on the start screen), each
`pager` page (`pager:<id>/<index>`, labelled from a `tabBar` or `bottomNav` that names the pager),
`bottomSheet` and `dialog`. Edges are `push`, `replace`, `pop`, `popToRoot` and `setPage` actions, from
the enclosing screen, each tagged with the `testTag`, `id` and text or label of the node that runs it
and its spec path. A `pop` targets `back` (the previous screen is runtime state), and `setPage` with
`next` or `prev` keeps the authored word. `visibleWhen` alternatives and sheet or dialog opening by
state are not resolved. The dynamic cross-check and the diff against `getNavigationGraph` are not built.

### Route contract

`prototype_routes_v1` gates stack `routes`, push/replace `params`, pop `force`, `setStack`,
route placeholders and `stack:<id>` storage keys. Android and iOS intentionally do not advertise
it until runtime support is implemented. `screens` remains a map of bare nodes; the optional
sibling `routes` map may contain only screen names of that stack. Each route has optional
`params: {name: "string"|"number"|"boolean"}` (at most 16, path-key names), `onEnter` and
`onBack` (1–32 actions each, with the existing action nesting budget). The start screen cannot
declare params because initial display and popToRoot cannot supply them. Param names use the
uncapped path-key identifier grammar; bound state keys are checked by the runtime.

Push and replace accept up to 16 scalar literals or existing state/data/item/index value bindings
in `params`. All declared params are required; unknown names and incorrectly typed literals are
rejected at the action. `setStack {stack, path:[{screen,params?}]}` validates each entry the same way
and requires 1–MAX_PROTOTYPE_STACK_DEPTH entries. A non-forced pop of the owning stack in
its screen's onBack list, including nested timer and request follow-ups, is rejected; `force:true`
bypasses that guard. Pops in dialog actions are independent. An onEnter list cannot push or replace
its own screen, including through nested action lists. Cross-screen lifecycle cycles, including
push/pop ping-pong, require runtime navigation-state guards. `{route.name}` uses the repeat tokenizer
and bindable fields, condition operands and whole data-pointer segments. Its name must be declared by the enclosing screen; lifecycle actions
use their named screen's scope. A nested stack's screen establishes its own scope. The `route` repeat
alias remains valid in specs without route features; route-enabled specs reserve it for params.

Storage accepts `stack:<id>` only for declared stacks. Navigation, param binding, lifecycle execution,
persistence/restore precedence and event emission are owed by the runtime slice. Status and inspect
reserve optional `stacks.<id>.params: object[]` parallel to the existing `path: string[]`;
`screen_changed` reserves optional scalar `params` alongside `screen` and `depth`. No new fields
are emitted by the current runtimes.

### Stack transitions

`prototype_stack_transitions_v1` gates every explicit stack `transition` and push/replace
`transition` override. Omission means `platform`; pop/popToRoot have no override. The contract
is validated by both agents, and both advertise the capability.

| Value         | Platform behaviour                                                                |
| ------------- | --------------------------------------------------------------------------------- |
| `platform`    | Native navigation animation (default).                                            |
| `slide`       | Directional screen slide, reversed on pop.                                        |
| `fade`        | Screen crossfade.                                                                 |
| `none`        | Instant screen change.                                                            |
| `sharedAxisX` | Sibling steps along a horizontal flow; 30dp travel plus fade.                     |
| `sharedAxisY` | Sibling steps along a vertical flow; 30dp travel plus fade.                       |
| `fadeThrough` | Unrelated destinations; outgoing fade, then incoming fade and scale from 0.92.    |
| `zoom`        | Item-to-detail container transform from the source key into the destination root. |

The four named patterns and push/replace `source` require `prototype_stack_patterns_v1`.
Zoom requires `source` on each push/replace using it, naming exactly one node's `sharedKey` or literal `shared.key`
inside the target stack's screens. A key referenced as a zoom source is exempt from the two-node visibility-pair rule;
repeat templates remain disallowed.
With `prototype_zoom_transition_v1`, Android shares bounds from the outgoing source to the incoming
root and iOS 18+ uses native navigation zoom. Older agents use fadeThrough on Android or platform
push on iOS 17, reported in `platformNotes`. The rendering capability does not add an authoring
requirement: `prototype_stack_patterns_v1` still accepts zoom and source.
Platform, slide and zoom support interactive iOS edge pop; only the composed sharedAxisX/Y and
fadeThrough patterns pop non-interactively. Fallback notes are returned on both platforms.
Android predictive back scrubs every pattern, including the zoom transform, and restores the current
screen on cancellation. PopToRoot reverses the entry edge immediately above the returned screen, using that edge's zoom source rather than the topmost entry's source; without a zoom edge it uses the stack's declared pattern.
Shared-axis pop reverses travel; only X also mirrors for RTL. iOS composes axis movement with
opacity and fadeThrough removes the outgoing screen visually before revealing the scaled incoming
screen. Fixed named timings are 300 ms for movement and 150 ms for fade effects (two sequential
phases for fadeThrough); the motion-token table is not available.

Android slides enter from the end edge with 30% outgoing parallax, mirrored in RTL; pop and
popToRoot reverse that direction. Platform replace crossfades. Animations finish within 300 ms.
`motion: "none"` and animator duration scale 0 snap immediately. The reduced profile (see Motion
profiles) changes every pattern to a crossfade.

Activity hosts scrub the pop with predictive back on API 34+, settle on commit, and restore the
current screen on cancellation. Earlier APIs pop with the ordinary animation. Overlay windows
and authored actions use ordinary transitions. Each path entry owns its scroll offsets, retained
while covered and discarded on pop, replacement or removal. Settled screen containers expose
`paneTitle`; outgoing content leaves composition and semantics after the animation.

Stack transitions, including a predictive-back scrub, count in the motion-active window signal
(#15114), so `observe(waitFor: stable)` waits them out.

A stack's `transition` is the screen navigation animation only. The stack's own `visibleWhen`
uses the default visibility animation; wrap the stack in a box to give that a custom transition.

### Motion v2 (#14208, `prototype_motion_v2`, not device-verified)

- **Animated style.** A node's `animate: {tempo?}` selects a contract spring (see Motion tokens), or
  `animate: {durationMs?, easing?}` selects timing (0–2000 ms, default 300;
  `standard` (default), `emphasized`, `linear` or `spring`, which ignores the duration) makes
  changes to its `alpha`, `offset`, `scale`, `rotation`, `background` and `color` animate, for
  example a heart that grows and turns red when a `styleWhen` matches. Without `animate` those
  changes stay instant.
- **Scale and rotation.** Style `scale` (0–4) and `rotation` (-360..360 degrees) are drawn about
  the node's centre without changing its layout slot, like `offset`; `styleWhen` can set them.
- **Transitions.** `transition` also takes `slideStart` and `slideEnd`, which slide in from and out
  to that edge (a drawer), and `scale`, which scales in with a fade. Start and end follow the layout
  direction, so drawers mirror in right-to-left locales.
- **Zoomable images.** An `image` with `zoomable: {maxScale}` (1–8) pinches between 1 and
  `maxScale`, pans within its own bounds once zoomed, and toggles between 1x and 2x (or
  `maxScale`) on a double tap; TalkBack gets "Zoom in" and "Zoom out" actions. The zoom is clipped
  to the image's box and does not change its layout or reported bounds. `onTap` still runs; a
  zoomable image cannot also have `onDoubleTap` (rejected at `<path>.zoomable`).
- **Reduced motion.** Under `motion: "none"` or animator duration scale 0, style changes and
  transitions snap, so `observe` and screenshots stay deterministic. Zoom changes are always applied
  directly.

Android draws scale and rotation with a `graphicsLayer`, animates with `animateFloatAsState` and
`animateColorAsState`, and zooms with `transformable`. The iOS agent does not implement motion v2
yet and does not advertise the capability (#14684), so the host refuses these fields there.

### Transition choreography (#15247, `prototype_choreography_v1`, not device-verified)

- **Delayed enters.** `transition` also takes `{type, delayMs?}` (`delayMs` 0-600 ms) in place of
  the plain name; the enter starts after the delay and runs a 300 ms tween. A delay applies to
  enters only, so a hidden node still leaves at once.
- **`blurReplace`.** A blur and fade: the node enters from a 12 dp blur that clears as it fades in,
  and leaves the other way. `Modifier.blur` does nothing below Android 12, which leaves the plain
  fade there.
- **Stagger.** A `box`, `row` or `column` takes `stagger: {ms, order?}` (`ms` 0-100; `order`
  `forward` (default), `reverse` or `center`). Its direct children with `visibleWhen` enter one
  after another in layout order, each `ms` apart, including the children a `repeat` makes. A child's
  own `transition.delayMs` adds to its stagger wait.
- **Limit.** No child waits more than 600 ms in all. The validator counts the children and a
  literal `repeat` and rejects a longer wait at `<path>.stagger`; a data-bound `repeat` has no
  static count, so the renderer clamps the wait to 600 ms instead.
- **Reduced motion.** Under `motion: "none"` or animator duration scale 0 nothing animates, so no
  delay applies and `observe` sees the settled tree.
- **Retained subtrees.** A large `fade` or `none` subtree that the renderer keeps composed while
  hidden (a scroll list) still fades without the delay.

The render model carries each child's wait as `enterDelayMs` (stagger rank times `ms` plus its own
delay, at most 600), so the stagger is decided with the tree and not while it draws. The iOS agent
does not advertise the capability yet, so the host refuses these fields there.

## Actions and state

| Action `type` | Properties                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emit`        | Required nonempty `name`; optional `context` of named bindings (see Emit context below); optional arbitrary JSON `payload` up to the 4 KiB conservative compact JSON budget (null and nested JSON allowed). |
| `setPage`     | Required existing `pager` ID; required `page`: `next`, `prev`, or nonnegative integer index up to 2147483647. Renderer clamps to available pages.                                                           |
| `setState`    | Required state `key` and scalar `value`; creates or replaces a key.                                                                                                                                         |
| `toggle`      | Required `key` that the spec's `state` declares as a boolean; flips it.                                                                                                                                     |
| `increment`   | Required `key` that `state` declares as a finite number; adds optional finite `by` (default 1, negative values decrement). Non-finite results are ignored.                                                  |
| `decrement`   | Same as `increment` but subtracts `by` (default 1); `decrement` with a negative `by` adds. Non-finite results are ignored.                                                                                  |
| `dismiss`     | No additional properties.                                                                                                                                                                                   |

### Emit context

Use a stable `emit.name` such as `pick` and `context: {id: {item: "id"}}` to report a
repeat item's id, instead of encoding the id into the event name. `emit.payload` stays literal
and uninterpolated; context is resolved on the device when the emit action runs, after earlier
actions in the same atomic `onTap` list. For example, setState then emit reads the new state.

Each nonempty context name has a strict binding object with exactly one key:

- `{state: key}` reads state; repeat placeholders such as `liked_{item.id}` bind to concrete keys.
- `{item: field}` reads a typed repeat field; `{index: true}` reads its zero-based numeric index.
  Both require a repeat template. The field must exist in every item; data-path repeats use the
  same scalar projection as text placeholders. Expansion replaces these bindings with `{value: ...}`.
- `{page: pagerId}` reads an existing pager's current numeric page.
- `{data: pointer}` reads any JSON value via the existing data pointer syntax and
  `MAX_PROTOTYPE_DATA_POINTER_LENGTH`; it also requires `prototype_data_model_v1`.
- `{value: json}` is literal JSON, subject to the emit payload depth limit.

Missing state keys and data paths resolve to null. `MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES` bounds the
number of entries. The resolved object's compact JSON UTF-8 bytes
are bounded by `MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES`; this runtime count includes multibyte strings
and compact JSON numbers, rather than the payload validator's conservative numeric cost.
If over budget, sort entries by ascending name (byte-wise UTF-8 order), keep the longest prefix
that fits and omit all remaining entries. An oversized first entry produces `{}`. The tap succeeds.

A show or patch replacement using `emit.context` requires `prototype_emit_context_v1`; older
devices are refused before upload, display or patch dispatch. The `prototype_event` wire has `context` next to the unchanged
`payload` only if the emit declared context (including an empty object). It has
`contextTruncated: true` only when truncated; otherwise the field is omitted, never false.
`awaitEvent` and host status preserve these fields.

No scripts, callbacks, expressions or implicit navigation. `setState` must preserve a text-field, selection
or sheet binding's scalar type at runtime (renderer-enforced, #9300).

### Data actions (#12519)

`setData {path, value}`, `appendData {path, value}`, `prependData {path, value}` and `removeData {path}` let a tap change `/data`
on the device, so "add to cart" or "delete row" needs no agent round trip. They require
`prototype_data_actions_v1` with `prototype_data_model_v1`; prepend also requires
`prototype_lazy_list_v1`. The
host refuses a show, or a patch whose resulting spec contains one, on a device without it, through
the same gate registry as every other capability (`PROTOTYPE_SPEC_CAPABILITY_GATES`, checked on
the complete result of `show`, `patch` and `replaceNode`).

- `path` is `/data` plus a non-empty RFC 6901 pointer, validated by the same
  `isPrototypeDataPointer` guard as `{data: pointer}` and patch ops (`MAX_PROTOTYPE_DATA_POINTER_LENGTH`);
  `/data` alone is refused. Inside a `repeat`, a whole `{index}` segment (`/data/cart/{index}`) binds
  to the current row; `{index}` elsewhere, outside a repeat, or `{alias.field}`, is a validation error.
- `value` takes the `emit.context` binding forms except `page`: `{value: json}` (the literal form),
  `{state: key}`, `{data: pointer}` and, in a repeat, `{item: field}` and `{index: true}`. A written
  value is data: no null.
- Semantics are one pure function, `applyPrototypeDataWrite` (`src/features/prototype/prototypeDataWrite.ts`),
  shared by the host mirror and meant for the device runtimes, `request` responses (#12523) and
  storage restores (#12522). `set` creates or replaces an object member or replaces an existing array
  element; `append` pushes one row onto an existing array; `prepend` inserts an ordered array at
  the start and trims from the end under maxItems; `remove` deletes an existing member or element and
  shifts later elements down. Errors are typed (`invalid_path`, `invalid_value`, `not_found`,
  `not_array`, `limit_exceeded`) and change nothing. The data after a write must satisfy the data
  depth and array limits and `MAX_PROTOTYPE_DATA_WRITE_BYTES`.
- The validator checks pointer syntax and `{index}` placement, rejects a literal value data cannot
  hold, and, when the target has no `{index}` and resolves in the spec's own `data`, rejects an
  `appendData` or `prependData` whose target is not an array. A target created only by an earlier write is the device's
  to check.

Each device write is reported on a `change` event, using existing wire fields so no event field is
added: `name` is the written `/data/...` path (for an append, the array) and `payload` is
`{op: "set"|"append"|"extend"|"prepend"|"remove", value?, maxItems?, revision}`. `validity` may accompany it; a `change` whose name
is a data path must carry a valid payload or the host drops it. `awaitEvent` returns it like any
other event.

Android: `PrototypeRuntime.writeData` (over the shared `PrototypeDataWriter`, a mirror of
`applyPrototypeDataWrite`) applies a write to an immutable copy of `/data` and Compose re-renders `repeat`
and `{data: ...}` bindings. A refused write (typed error, unresolvable value binding, rows the renderer
cannot take) changes and emits nothing, is logged, and the rest of the list still runs. Each accepted write
takes its own revision. The event carries the value only while the payload fits
`MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES`; otherwise it is left out and the host stops tracking the spec. With no
host connected, a device-persistent prototype's write events wait in `PrototypeOfflineEventBuffer`.

**Revisions and host patches.** The device has one revision counter per prototype, shared with iOS
(#13040): every `show` takes the next revision (the first show of an id is revision 1, a re-show
moves it on, none rewinds it) and both platforms replay
`test/fixtures/prototype-spec/revision/show-revisions.json` to pin it. A data write bumps
it and reports the new value as `payload.revision`; a patch result's `revision` is the same counter.
The agent's `/data` patch and a device write must not silently lose each other, so:

1. The host applies every reported write to its tracked copy of the spec and to `status` data with
   `applyPrototypeDataWrite`, keeping the copy exact. If it cannot (the value did not travel, the copy
   disagrees, or a show is in flight so the order is unknown) it stops tracking the spec and removes
   the reported data; the next patch requires a show first.
2. It also logs `{path, revision}` of each write (the last 64 per prototype, remembering the newest
   revision it forgot). A show of that id clears the log.
3. Until the device has written a prototype's data, `/data` patches behave as before. After that, a
   patch with a `/data` op requires `baseRevision`, and the host refuses it before sending, with the
   existing `conflict` shape plus the touched paths (`conflict: {revision, state: {}, data: [paths]}`),
   when a write newer than `baseRevision` touched a path that overlaps an op path (equal, ancestor or
   descendant), or when `baseRevision` is older than the forgotten writes. A device receiving a
   `/data` patch applies the same rule against its own history. `replaceNode` and `/state` ops are
   unaffected.

A device write bumps the device revision and is reported in the change event; a stale `baseRevision` gets
the existing conflict. Host bookkeeping lives in `PrototypeShownSpecs` (`recordDeviceDataWrite`,
`dataPatchGuard`), called from `InMemoryPrototypeStatusStore.recordEvent` and `performPrototypePatch`.

### Storage (#12522)

A show resets `state` and `data` to the spec's values, saved prototypes keep the spec and assets but
no user data, and the offline event buffer is lost if the process dies. A root-level `storage` block
names the values the device keeps for the prototype:

```jsonc
"storage": { "version": 1, "keys": ["state:darkMode", "data:/cart"] }
```

The capability is `prototype_storage_v1` (`PROTOTYPE_STORAGE_CAPABILITY`). A show, or a patch whose
resulting spec contains `storage`, is refused on a device without it through the same gate registry
as every other capability (`PROTOTYPE_SPEC_CAPABILITY_GATES`, field `storage`).

**Shape and validation.** The block is strict: `version` is an integer from 1, `keys` holds 1 to
`MAX_PROTOTYPE_STORAGE_KEYS` (64) unique strings. The contract (`schemas/prototype-spec-contract.json`,
definition `storage`) checks the shape; `prototypeStorageError` (`src/features/prototype/prototypeStorage.ts`)
checks the rest, with the path of the first problem:

- `state:<key>`: the key matches the state-key pattern and is declared in the spec's `state`.
- `data:<pointer>`: an RFC 6901 pointer to a member of `data`, validated with `prototypeDataPathPointer`
  (which wraps `isPrototypeDataPointer`) on `/data` + pointer, so `data:/cart` is the path `/data/cart`
  that data actions and patch ops use. The whole document (`data:` alone), a pointer without a leading
  `/`, or an over-long pointer is refused. Two data pointers where one is the other's ancestor or equal
  (`/cart` and `/cart/items`) are refused, so each stored value has one owner.
- Duplicate keys are refused.
- The values the spec itself holds for the listed keys, counted per entry as the UTF-8 bytes of the
  storage key plus the compact JSON of the value, must fit `MAX_PROTOTYPE_STORAGE_BYTES` (262144).

| Constant                      | Value  | Counting rule                                                                             |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `MAX_PROTOTYPE_STORAGE_BYTES` | 262144 | Stored bytes per prototype id: sum over stored entries of key bytes + compact JSON bytes. |
| `MAX_PROTOTYPE_STORAGE_KEYS`  | 64     | Entries in `storage.keys`.                                                                |

**What is stored.** After every write the device saves the listed keys under the spec `id`: a user
write (a tap, a text edit), a device data action (`setData`, `appendData`, `prependData`, `removeData`) or a `request`
response (#12523) that writes state or data. A write that would take the stored total over
`MAX_PROTOTYPE_STORAGE_BYTES` still applies on screen, is not stored (the previous stored value of
that key stays) and the key is listed in `skippedKeys` of the inspect report. Stored values are part
of the device's per-id state: they survive a dismiss, a process restart and a saved prototype's relaunch.

**Precedence (adopted decision, #12522).** The rules below are implemented once as the pure function
`restorePrototypeStorage` (`src/features/prototype/prototypeStorageRestore.ts`), the reference the device
runtimes follow, as `applyPrototypeDataWrite` is for data actions.

1. On the next show of the same `id`, stored values replace the spec's values for the keys the spec
   lists. This applies to a same-id replacement, to a show after a dismiss and to a saved prototype's
   launch. The rest of the spec's `state` stays authoritative (see Re-showing). `reset: true` only
   restarts pager pages and display; it does not clear storage (use `clearStorage` first).
2. If `storage.version` differs from the version the values were stored under, every stored value
   of that id is discarded and the spec's values stand. Authors bump `version` when a key's meaning or
   shape changes.
3. A stored key that `storage.keys` no longer lists is dropped, and a show with no `storage` block
   drops every stored value of that id (as if `keys` were empty).
4. A stored value that no longer fits the spec is dropped and the spec's value stands: a `state`
   value whose type (string, finite number, boolean) differs from the spec's value, a `state` key the
   spec no longer declares, a `data` value of a different JSON kind than the spec's own value at that
   pointer (object, array, string, number, boolean), or a value `applyPrototypeDataWrite` refuses as
   a `set` (a missing parent, a data limit). Dropped entries are deleted from storage.
5. Restoring happens before the first draw and sends no `change` event; the show result and the
   host's cached state and data still describe the spec's values. Call `inspect` to read the live
   values.
6. **Host `patch` against a stored key.** The patch wins. It applies under the existing
   `baseRevision` conflict rules (a stored restore is not a device write and does not bump the
   revision or enter the write log), and the device then stores the new value like any other write.

**Host tool support.**

- `inspect` reports what the device stores. The device reports, per prototype in its
  `inspect_prototypes` reply (and flat in the iOS agent's status), a `storage` object:
  `{version, keys: [{key, bytes}], totalBytes, skippedKeys?}` (`PrototypeStorageReport`). `keys` lists only
  keys that currently hold a stored value, in storage-key form (`state:darkMode`, `data:/cart`).
  The host passes it through as `storage` on the prototype entry, and reports it absent when the
  device sends none (no `prototype_storage_v1`, or no `storage` block) or sends a malformed one.
  `status` shows the last inspected value and drops it after a successful `clearStorage`.
- `{action: "clearStorage", id}` wipes the stored values of `id`. The host sends
  `{type: "clear_prototype_storage", requestId, id}` (Android CtrlProxy; the iOS agent receives the
  same request type) and the device answers one `prototype_result` with `success` and `cleared`, the
  number of keys removed (0 for an id with nothing stored). The prototype on screen is not changed;
  the next show of the id starts from the spec's values. It is refused before anything is sent, with
  a message naming `prototype_storage_v1`, when the device does not advertise it.
- `deleteSaved` also clears the id's storage. This is device-side behavior and part of the contract:
  deleting a saved prototype removes its spec, assets, shortcut and stored values, so a later save of
  the same id starts clean. `delete_saved_prototype` needs no new flag. On iOS the saved prototype is
  its own app, so deleting the app removes its storage with it.

**Android CtrlProxy (#12525).** Advertises `prototype_storage_v1`; the rules live in
`PrototypeStorageRestorer` (`android/protocol`, the pure twin of `restorePrototypeStorage`),
`PrototypeStoragePersistence` / `PrototypeStorageSession` and `PrototypeStorageStore`
(`android/control-proxy/.../prototype`).

- **Store.** `PrototypeStorageDirectoryStore` keeps one document per id at
  `filesDir/prototype-storage/<slug>-<hash16>.json` (slug as saved prototypes use, then 16 hex chars of the
  id's SHA-256): `{"id", "version", "values": {"state:dark": true, "data:/cart": {...}}}`. A save writes
  `<name>.tmp`, syncs and renames, so a reader sees the old or new document. An unparsable document, wrong
  shape or another id's document is `Corrupt`: the show uses the spec's values, logs a warning and deletes
  it.
- **Show.** Restore runs before the runtime is built, so the first draw has the stored values; the runtime
  starts at the spec's revision and sends no `change`. Dropped entries are deleted at once. The restored
  spec must pass the same validation as a shown one (a stored text breaking `maxLength` would not),
  otherwise every stored value is dropped. A same-id show first flushes the shown prototype's pending write.
- **Write-back.** After each interaction and patch the session compares the listed keys with what it last
  saw and stores only those that changed, so an untouched key keeps following the spec. The first change of
  a burst arms one write `PROTOTYPE_STORAGE_DEBOUNCE_MILLIS` (500 ms) later; dismissal (any reason,
  including teardown), replacement and the saved activity's `onStop` flush at once. A failed write is
  logged and retried at the next flush. `request` responses are covered because they write through the same
  paths.
- **Limit.** Per id, entries are summed against `MAX_PROTOTYPE_STORAGE_BYTES`. A write that would pass it
  applies live, is not stored, keeps the key's previous stored value and lists the key in `skippedKeys`
  until a later write fits.
- **Removed pointers.** A listed `data:` pointer removed by a data action loses its stored value (JSON
  `null` is not stored), so the spec's value returns on the next show.
- **Surfaces.** The overlay (`PrototypeController`), `persistence: "device"` prototypes and
  `SavedPrototypeActivity` all use it; a service prototype and the saved activity of the same id share one
  file (last write wins).
- **Host actions.** `clear_prototype_storage` clears the shown session (and its pending write) or, for an id
  nobody shows, the document; the prototype on screen keeps its live values. `delete_saved_prototype`
  clears the id's storage after deleting the saved copy.
- **Reinstall (not built).** Stored values live in `filesDir`: they survive dismiss, process restart and a
  saved prototype's launch, not an uninstall, data clear or the reinstall fallback. The #12268 host mirror
  records saved prototypes from what the host sent at `save`; mirroring stored values would need a
  device-to-host export (a new wire message plus a `restoreSavedPrototypes` re-seed).

### Request action (#12523)

```json
{
  "type": "request",
  "method": "GET",
  "url": "http://localhost:8080/feed",
  "headers": { "Accept": "application/json" },
  "query": { "q": { "state": "search" } },
  "into": "/data/feed",
  "statusKey": "feedStatus",
  "via": "host",
  "onSuccess": [{ "type": "setState", "key": "loaded", "value": true }],
  "onError": []
}
```

A `request` calls an HTTP endpoint from a tap, writes the answer into `/data` and reports its
progress in a state key, so a prototype can load and post real content with no agent round trip.
It requires `prototype_network_v1`, and `prototype_network_device_v1` as well when `via` is
`"device"`; both are entries in `PROTOTYPE_SPEC_CAPABILITY_GATES` (the second gate's fields are only
the via-device requests), so show, patch and `replaceNode` refuse a spec containing one on a device
without them. A device advertising `prototype_network_v1` also writes `/data` for `into`, with the
`applyPrototypeDataWrite` semantics, without `prototype_data_actions_v1`.

| Field                  | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                  | Required, at most 2048 characters. Any absolute `http` or `https` URL. Host requests apply the egress policy described below. Takes the text placeholders of any text field: `{key}` (state), `{data:/pointer}`, `{item.field}`, `{index}`. Without a placeholder it must parse as an http(s) URL; with one, only the literal `http://` or `https://` prefix is checked, because the rest is known when the request runs. The issue's `{state:key}` spelling does not exist in the placeholder grammar; use `{key}`.                                                                                                                                                                                                                                                                                                                                  |
| `method`               | `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE` or `HEAD`, the same `PROTOTYPE_REQUEST_METHODS` the host executor accepts. `body` is refused with `GET` and `HEAD`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `headers`, `query`     | Up to 16 entries each: a literal string (text placeholders apply) or a value binding `{state}`, `{data}`, `{value}`, and `{item}` / `{index: true}` in a repeat. A bound value must be a string, number or boolean. Header names must be HTTP tokens. Query entries are set on the URL in sorted key order (UTF-16 code units, like JS `sort()`), on every runtime, so the resolved URL does not depend on authoring order. With no authored `query` the URL's raw query is kept verbatim. Each authored key replaces the value at its first existing piece in place and removes later duplicates; new keys are appended in sorted order. Only those pieces are re-encoded (form encoding: space is `+`, `~` is `%7E`); untouched pieces keep their exact spelling (`?flag`, `%20`). E.g. `?a=1&b=x%20y&a=3&c` with `{a:"2"}` gives `?a=2&b=x%20y&c`. |
| `body`                 | A value binding, so a literal is `{value: json}`. Non-string values are sent as JSON with `Content-Type: application/json` unless a header sets one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `into`                 | `/data/<pointer>` with the data-action rules (whole `{index}` segment in a repeat). It must name an object member, not an array element, and its parent must exist. Optional: without it nothing is written to data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `statusKey`            | A declared **string** state key (a numeric or boolean key is refused). Set to `"loading"`, then `"success"` or `"error"`, so `visibleWhen` can show a spinner or an error. Inside a repeat it may hold placeholders like any state key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `via`                  | `"host"` (default) or `"device"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `timeoutMs`            | Optional integer, 1 to `MAX_PROTOTYPE_REQUEST_TIMEOUT_MS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `onSuccess`, `onError` | Optional action lists (1 to 32). Recursive: a request may carry requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Limits** live in the contract's `limits` and `src/features/prototype/prototypeRequestLimits.ts`
reads them from there (the contract is the single source for the host executor, the validator and
the native runtimes):

| Limit                                  | Value                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS` | 10000                                                                                                                                                                                                          |
| `MAX_PROTOTYPE_REQUEST_TIMEOUT_MS`     | 30000 (a larger `timeoutMs` is a validation error; the host clamps)                                                                                                                                            |
| `MAX_PROTOTYPE_RESPONSE_BYTES`         | 262144, never above `MAX_PROTOTYPE_DATA_WRITE_BYTES`, so an accepted response is one `/data` write                                                                                                             |
| `MAX_PROTOTYPE_REQUESTS_IN_FLIGHT`     | 4 per device                                                                                                                                                                                                   |
| `MAX_PROTOTYPE_ACTION_DEPTH`           | 4: a top-level action is level 1 and each `onSuccess` / `onError` adds one. The contract walk counts it like selector and condition depth; Zod does not, and treats follow-up entries as actions of any depth. |

**Response handling** is the pure function `applyPrototypeRequestOutcome`
(`prototypeRequestOutcome.ts`), the reference the device runtimes copy:

1. A 2xx response is written to `into` as `set` does: parsed JSON as it is, any non-JSON body as a
   string, an empty body (and a HEAD) as `""`. If the value is not data (it holds null, or breaks a
   depth, array or byte limit) the request is an error with `error.code` `invalid_response` and `into`
   is left alone.
2. A non-2xx status leaves `into` untouched and is an error with `error.code` `http_error`
   (`message` `HTTP <status>`). The status decides this before the body is consumed: a non-2xx body
   is never read or capped (it is reported as `null`), so an oversized error page is `http_error`,
   not `too_large`; the size cap applies to 2xx bodies only. A transport failure is an error with the executor's code (`timeout`,
   `too_large`, `connection_refused`, `blocked_destination` (the destination is not permitted), `cancelled`, `invalid_url`, `invalid_request`, `network`,
   `too_many_in_flight`).
3. With `into`, the metadata is then written to **`<into>__meta`**: the same pointer with `__meta`
   appended to its last segment (`/data/feed` reports at `/data/feed__meta`; `prototypeRequestMetaPath`).
   Its value is `{status?: number, headers?: {name: value}, durationMs: number, error?: {code, message}}`.
   `status` and `headers` (lower-cased names) exist once a response arrived; `error` exists for every
   failure. If it does not fit the data write limit, `headers` is dropped. The completion is atomic: if
   the body fits `/data` but no form of `__meta` fits beside it, `into` is left unchanged and the request
   is an error with `error.code` `invalid_response` (message `response and metadata exceed the data
   limit`); its minimal metadata (duration and error) is still written if it fits, the status key
   becomes `error` and `onError` runs.
4. `statusKey` becomes `"success"` or `"error"`, the request event is sent, then `onSuccess` or
   `onError` runs.

**Event.** A finished request is an `emit` event with `name` `prototype_request` (reserved; an
authored `emit` with that name is a validation error) and a payload decoded by
`prototypeRequestEventOf` (`prototypeRequestEvent.ts`), so no wire field is added and
`ctrlProxyWireManifest.ts` is unchanged:

```json
{
  "requestId": "r-1",
  "method": "GET",
  "url": "https://api.example.com/feed?q=cats",
  "via": "host",
  "into": "/data/feed",
  "outcome": "success",
  "status": 200,
  "durationMs": 31
}
```

`outcome` is `"success"` or `"error"`; `error: {code, message}` is present exactly for `"error"`;
`status` is absent when no response arrived; `url` is the resolved URL cut to 2048 characters and
`message` is cut to 512. A malformed payload under that name drops the event, as for data writes.
`awaitEvent {kind: "emit", eventName: "prototype_request"}` returns it. The `/data` writes of
step 1 and 3 are `change` events as for data actions, sent before it.

**Concurrency (device runtime).** A request whose `into` already has one in flight cancels the
first: the latest wins. The cancelled request writes nothing to `into`, `<into>__meta` or `statusKey`,
runs no follow-up and reports a `cancelled` event. A `via: "host"` call sends
`{"type":"prototype_request_cancel","requestId":"<id>"}` to the host (also on dismiss, reset or
abandonment): the host aborts that request's fetch, frees its in-flight slot and sends no reply, and the
device ignores a `prototype_response` that crosses it. The frame is not in the Kotlin-mirrored wire
manifest, like `prototype_request`. Beyond `MAX_PROTOTYPE_REQUESTS_IN_FLIGHT` a new request fails with
`too_many_in_flight`. Dismissing the prototype cancels its requests. `via: "device"` loopback URLs
are reversed as described in [Loopback requests from the device](#loopback-requests-from-the-device-12530).

**Android runtime (#12528).** CtrlProxy advertises both capabilities and runs the action in
`PrototypeRuntime`; the Kotlin twins of the TypeScript rules (`PrototypeRequest.kt`: resolver,
`PrototypeRequestOutcome`, event payload) are tested against the same fixture, `request-actions.json`.

- `statusKey` becomes `loading` in the tap's own interaction. The request then waits off the interaction on
  the controller's scope and completes under the controller's lock, so a response never lands mid-tap.
  Completion order is the contract's: `into`, `<into>__meta`, `statusKey`, the `prototype_request` event,
  then `onSuccess` / `onError`. A request that cannot start (unresolvable binding, in-flight cap) finishes
  at once as an error without a `loading` step.
- Both transports implement `PrototypeHttpClient`. `via: "host"` sends a `prototype_request` frame to the
  latest connected host over the CtrlProxy socket and waits for the `prototype_response` with the same
  `requestId` (a silent host times out five seconds after the request's own timeout; no host fails at once
  with `network` naming `via: "host"`). `via: "device"` is one Retrofit service (`PrototypeHttpService`)
  over an injected `OkHttpClient` with raw bodies and no converter, read with the
  `MAX_PROTOTYPE_RESPONSE_BYTES` cap; the contract timeout is the whole-call timeout. The two frames
  (`PrototypeNetworkFrames.kt`) stay outside the `WebSocketRequest` / `WebSocketResponse` hierarchies
  because the host reads them outside its Kotlin-mirrored wire manifest.
- Any absolute http(s) URL is allowed: CtrlProxy declares `android.permission.INTERNET` and a
  `network_security_config` with `cleartextTrafficPermitted="true"`. There is no host allowlist; CtrlProxy
  is sideloaded over adb and never distributed.
- Saved prototypes (`SavedPrototypeActivity`) run `via: "device"` on the same client; `via: "host"` finishes
  as an `invalid_request` error because no host serves the activity.

The shared fixture `test/fixtures/prototype-spec/valid/request-actions.json` covers both `via` values,
`onSuccess` / `onError`, nesting, `statusKey` and `visibleWhen` on the status. A typical feed shows a
spinner with `visibleWhen: {key: "feedStatus", equals: "loading"}` and the failure with
`{data:/feed__meta/error/message}` under `equals: "error"`.

### Share contract

`requires.platform: ["share"]` enables the `share.open` platform-call grammar; its generated
gate is `prototype_platform_share_v1`. Neither runtime advertises that capability until its
system-sheet driver is implemented. There are no share events or `/platform/share` state keys.
The existing `into`, `statusKey`, `onSuccess`, `onError`, timeout and `prototype_platform`
completion contract applies. A cancelled sheet must fail with `cancelled` and run `onError`.

Arguments use value bindings. At least one nonblank `text`, nonempty `url`,
`images`, `files`, or `contact` is required; `subject` alone is not an item.
`subject` is optional; the error for `title` directs callers to use `subject`. String values use `{key}`,
`{data:/pointer}`, `{item.field}`, `{index}` without rescanning substitutions. Missing state
or item text remains literal; missing/non-scalar data text becomes empty. Missing whole-value
bindings fail with `invalid_args`. Data, event, and platform pointer roots must be objects;
arrays can be traversed below an object member, but an array root is a missing binding. URLs must have a literal http(s) scheme; placeholders elsewhere are checked again after binding;
relative, javascript, data, file, and prototype deep-link URLs are refused. Userinfo, backslashes, ASCII whitespace, C0/C1 controls, NBSP, U+2028–U+202E, and
U+2066–U+2069 are refused by the portable URL grammar.

Images contain 1–10 uploaded asset IDs, `{asset: id}` objects, or `{data: "/pointer"}` objects
resolving to either uploaded-ID form. Files contain 1–4 `{asset, name, mimeType}` objects.
Names are 1–128 UTF-8 bytes, cannot start with a dot, and cannot contain path separators or
C0/C1 controls, NBSP, U+2028–U+202E, or U+2066–U+2069. Windows reserved device names,
colons, trailing dots, and ordinary spaces are allowed by this platform-neutral contract. MIME values are nonempty RFC token `type/subtype` values, with no parameters.
No device-local media type is introduced. A complete `shareAssetIds` inventory enables static
unknown-ID refusal; bundle references use the existing asset lookup, and pure resolution always
checks the supplied uploaded inventory. Every referenced entry must include a nonnegative
safe-integer `bytes` value; malformed metadata fails with typed `invalid_args`. Existing asset transport limits and supported media types
still apply; the contract does not add PDF or other upload formats.

Contact fields are exactly `name` (nonblank, required), `phone`, `email`, `org`, `url`, `note`.
The pure `resolvePrototypeShare` twins produce vCard 3.0 (`text/x-vcard`, `public.vcard`):
`FN` and an unstructured family `N` hold name, with `TEL`, `EMAIL`, `ORG`, `URL`, `NOTE` in that
order. TEXT properties escape backslash, comma, semicolon and CR/LF; the URI-valued `URL`
property is preserved verbatim. Lines use CRLF, and lines fold at
75 UTF-8 octets (continuation space included), without splitting a Unicode scalar.
No Contacts permission is needed. Each string is bounded by `MAX_PROTOTYPE_SHARE_TEXT_BYTES`
(65536); literal and resolved arguments use the same rules. Library imports refuse secure
state in every share string, including nested contact/file values and follow-up handlers.
The library secure-value scan guard caps total expanded bytes at 4,194,304 bytes, measured as
authored UTF-8 sink bytes charged per repeat row before allocating repeated strings; zero-row
templates are charged once. It charges literal spans even when substitution would shorten them.
This is not a one-pass pre-scan; it is conservative: may refuse legitimate large library specs; a pre-scan would be exact.

Pure resolution returns `{ok:true,payload,summary}` or
`{ok:false,error:{code:"invalid_args",path,message}}`. Payload includes uploaded image IDs,
files with supplied byte metadata, optional text/url/subject and optional `vCard`. Summary is
`{outcome:"shared"|"unknown",target?,items:{text?,url?,subject?,images,files,contact}}`, with
file entries `{name,mimeType,bytes}`. Text is truncated to 2048 Unicode scalar values, never
splitting a surrogate pair. The pure function defaults to `unknown`; only a future driver may
supply completion evidence. Android `shared` will mean a chosen target, not completed delivery;
iOS uses its activity completion flag. `target` is the chosen package/activity raw value.

The contract has no system-sheet dispatcher or fake-mode behavior. `platformMode` and
`prototype simulate` are not accepted by this vocabulary.

#### Known platform differences

- Lone surrogates are not representable in portable JSON/UTF-8 input as Unicode scalar values.
  Escaped lone UTF-16 code units can reach the TypeScript and Kotlin resolvers, but Swift's
  JSON decoder refuses them before resolution. TypeScript preserves those code units in JSON
  output; Kotlin's UTF-8 output encoder replaces them with `?`. These decoder/encoder differences
  occur before or after the resolver and do not define portable share behavior.
- Components are a host expansion feature. TypeScript validates component declarations, replaces
  each `use` with its bound plain-node tree, and removes `components` before transport. Native
  validators accept that expanded plain-node transport; they reject raw host declarations at
  `components`. The host can instead report a component-definition or prop error, or reach the
  share capability check after expansion. Comparing raw host specs at these different boundaries
  therefore produces different error paths or messages without a native share-contract mismatch.

### Platform actions and events (#14294)

The platform vocabulary is the one shape every platform integration uses (notifications, media,
location, share and so on): a `platform` action calls the platform from a tap, root `platform.on`
handlers react to platform events, `{platform}` reads show live platform state, and a root
`requires` block declares up front what the spec needs. It is modelled on the `request` action.
This section is the contract and the host validation; running the calls is the device module
registries' job (#14295 on Android, #14296 on iOS), and no production runtime advertises it yet.

```json
{
  "requires": {
    "platform": ["notifications", "media"],
    "permissions": [{ "name": "notifications", "purpose": "Alerts when a new episode is out" }],
    "background": ["audio"]
  },
  "platform": {
    "on": {
      "media.ended": [{ "type": "setState", "key": "playing", "value": false }]
    }
  }
}
```

```json
{
  "type": "platform",
  "call": "notifications.post",
  "args": { "title": { "value": "New episode" }, "body": { "data": "/episodes/0/title" } },
  "into": "/data/lastPost",
  "statusKey": "postStatus",
  "timeoutMs": 5000,
  "onSuccess": [],
  "onError": []
}
```

**Modules.** The contract's top-level `platformModules` table is the single source for every call
and event: each module names its capability, and each call its arguments (with the contract rule
a literal `{value}` argument must satisfy), the permissions and background names it needs, and a
`sensitive` flag for the threat model (#14293). The validators and the capability gates read the
table, so a module is added by adding its entry. The placeholder module `test` (`test.echo`,
`test.protected`, the `test.tick` event, capability `prototype_platform_test_v1`) makes the
vocabulary testable before any real module exists; no production runtime advertises it.

**Device status (#14316).** Three state-only modules expose read-only device status under
`/platform/<module>/<key>`; a spec lists the module in `requires.platform` and reads keys with the
`{platform}` forms. Each module has a `<module>.changed` event, debounced to one delivery per
500 ms, whose `{event}` data carries the new values. Unknown keys and events fail validation with a
path. No production runtime advertises them yet: the Android and iOS readers are #14322 and #14323.

| Module (capability)                         | Keys                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `battery` (`prototype_platform_battery_v1`) | `level` 0-100, absent when unknown; `state` `charging`, `full`, `unplugged` or `unknown`                                                                                              |
| `power` (`prototype_platform_power_v1`)     | `saver` boolean; `thermal` `nominal`, `fair`, `serious` or `critical`                                                                                                                 |
| `audio` (`prototype_platform_audio_v1`)     | `volume` 0-100 (media stream); `muted` boolean; `route` `speaker`, `wired`, `bluetooth`, `usb`, `airplay`, `cast` or `other`; `ringer` `normal`, `vibrate` or `silent` (Android only) |

**Connectivity (#14273).** The `connectivity` module (`prototype_platform_connectivity_v1`) follows the
same shape: `/platform/connectivity/online` and `metered` and `constrained` are booleans, and
`transport` is `wifi`, `cellular`, `ethernet`, `vpn`, `other` or `none`. `constrained` is iOS Low Data
Mode or Android Data Saver. `connectivity.changed` is debounced to one delivery per 500 ms. No
production runtime advertises it yet.

The thermal mapping is normative: Android `PowerManager.THERMAL_STATUS_*` 0 is `nominal`, 1-2
`fair`, 3 `serious` and 4-6 `critical`; iOS `ProcessInfo.ThermalState` maps one to one.

**Biometric prompt (#14328).** The `biometric` module (`prototype_platform_biometric_v1`) has one call,
`biometric.authenticate` with `title` (required, 1-64 characters), `subtitle` (optional, 1-128) and
`allowDeviceCredential` (optional boolean), and one event, `biometric.attemptFailed`, for a rejected
attempt while the prompt stays up. It has no `/platform` state and needs no declared permission. The
call proves presence only and returns no biometric data. Failures use the typed codes: `cancelled`, and
`unavailable` for a locked-out, unenrolled or hardware-less device. No production runtime advertises the
module yet.

**Settings deep links (#14320).** The `settings` module (`prototype_platform_settings_v1`) has one call,
`settings.open` with `page` one of `app`, `notifications`, `location`, `wifi`, `bluetooth` or `display`. The
list is closed and the target package is always the prototype's own runtime package; a spec cannot name
another. The module has no events or `/platform` state. Pages other than `app` and `notifications` are
Android only; the host validator does not yet know the target platform, so that restriction is reported by the
runtime. No production runtime advertises the module yet.

**Contact and calendar pickers (#14318).** Two modules reach the system pickers, which return only what the
user picks and need no declared permission. `contacts` (`prototype_platform_contacts_v1`) has
`contacts.pick` with an optional `multiple` boolean; it is `sensitive` because the result is personal data.
`calendar` (`prototype_platform_calendar_v1`) has `calendar.insert` with `title` (required, 1-256
characters), `start` and `end` (required, whole milliseconds since the epoch), `allDay`, `location` (1-256) and
`notes` (1-2048). Neither module has events or `/platform` state, and a back-out is the typed error
`cancelled`. The contract cannot yet check an enum list, so the contact `fields` selector is not an argument.
No production runtime advertises either module yet.

**Outbound links (#14238).** The `links` module (`prototype_platform_links_v1`) has one call, `links.open`
with `url` (required, at most 2048 characters) and `mode` (optional: `external`, `inApp` or `auto`). The
`openUrl` contract pattern is an allowlist: the URL must start with a lowercase `http`, `https`, `mailto`,
`tel`, `sms`, `geo` or `maps` scheme and contain no whitespace or control characters. `intent:`, `file:`,
`content:`, `javascript:`, `data:` and any custom scheme fail validation in all three validators, so a
spec cannot name a component or an arbitrary handler, and a URL that begins with a placeholder has no literal
scheme, so it fails the same pattern. `inApp` opens only `http` and `https` URLs, because Custom Tabs and
`SFSafariViewController` load only web pages: all three validators refuse a literal non-web URL with
`mode: inApp`, and the Android and iOS runtimes refuse the same pair as `invalid_args` once bound arguments
resolve. The module has no events or `/platform` state.

CtrlProxy registers the Android `links` runtime and advertises the capability; the embedded renderer
leaves the module to its host app. An omitted `mode` is `auto`. `tel:` starts `ACTION_DIAL` (never
`ACTION_CALL`, so no call is placed and no `CALL_PHONE` is needed), `mailto:` and `sms:` start
`ACTION_SENDTO` (a composer; nothing is sent), and every other scheme starts `ACTION_VIEW`, always with
`FLAG_ACTIVITY_NEW_TASK` because the overlay is not an activity. Only `http` and `https` can open in a
Custom Tab. The Custom Tab intent targets one Custom Tabs browser, the default browser when it provides
them and otherwise the first that does, so an App Link app cannot take the URL. The runtime writes the
Custom Tabs session extra itself, so CtrlProxy needs no `androidx.browser` dependency. `inApp` with no Custom Tabs service (AOSP images without Chrome) opens
externally and reports `outcome: "fallback"`; `auto` makes the same choice and reports `opened`. Success
writes `{outcome, url, mode, handler?}`, where `url` is cut to 2048 characters, `mode` is how the URL
actually opened (`external` or `inApp`) and `handler` is the resolved package. No resolving activity
fails with `unavailable`.

**Media actions: system picker and camera (#14197).** Two modules start platform UI that needs no app
permission and write device media items (see "Device media items") to `into`.
`mediaLibrary` (`prototype_platform_mediaLibrary_v1`) has `mediaLibrary.pick` with `media` (required:
`images`, `videos` or `imagesAndVideos`) and `maxItems` (optional whole number 1-64, default 1; 1 writes one
item, more writes an array; Android clamps it to `MediaStore.getPickImagesMaxLimit()`). `camera`
(`prototype_platform_camera_v1`) has `camera.capture` with `media` (required: `image` or `video`) and
`maxDurationMs` (optional whole number 1-600000, used only for video). They are separate modules, so a
device that has a picker but no camera (an iOS Simulator) advertises only `mediaLibrary`. Both calls are
`sensitive` and have no events or `/platform` state. A cancel leaves `into` untouched and runs `onError`
with `cancelled`; other codes are `unavailable` (no camera; detail `missing_usage_description` when the iOS
plist key is missing), `platform_error` (detail `media_limit` or `io`) and `too_many_in_flight` (one
system-UI call per prototype at a time). No production runtime advertises either module yet.

**Fake sign-in (#14303).** The `auth` module (`prototype_platform_auth_v1`) has two calls. `auth.signIn` takes
an optional `style` (`chooser` or `button`), shows a runtime-owned "Simulated sign-in" sheet and writes
`{userId, name, email}` into `into`; it is `sensitive`, and a back-out is the typed error `cancelled`.
`auth.signOut` takes no arguments. The `auth.sessionExpired` event and the read-only keys
`/platform/auth/signedIn` (boolean) and `/platform/auth/userId` complete the module. No argument or key carries
a password, secret or session token: the runtime keeps the token in the Keystore or Keychain and never exposes
it. The root `auth` accounts block is not in the contract yet, and no production runtime advertises the module.

**Haptics and sound (#14329).** The `haptics` module has one call,
`haptics.perform` with `effect` one of `click`, `tick`, `heavyClick`, `doubleClick`, `selection`,
`success`, `warning`, `error`, `impactLight`, `impactMedium`, `impactHeavy` or `longPress`
(capability `prototype_platform_haptics_v1`). The `sound` module has `sound.play` with `sound`
one of `click`, `send`, `receive` or `shutter` and an optional `volume`, a whole number 0-100
(`prototype_platform_sound_v1`). Both lists are closed: a literal `{asset: ...}` sound is refused
until the audio asset type (#14254) lands. Neither module has events or `/platform` state, needs a
runtime permission (`VIBRATE` is a normal permission, declared by CtrlProxy) or touches personal
data. CtrlProxy and the iOS prototype agent register both modules and advertise the capabilities;
the embedded Compose renderer leaves modules to the app.

- **Android haptics** use the `Vibrator`: from API 29 `VibrationEffect.createPredefined` (click and
  impactMedium click; tick, selection and impactLight tick; heavyClick, impactHeavy, longPress and
  warning heavy click; doubleClick and success double click), `error` a two-pulse waveform; below
  API 29 a tuned one-shot or waveform. There is no tapped `View` to call
  `performHapticFeedback(CONFIRM/REJECT)` on, so success, warning and error use these fallbacks.
  Touch feedback off in system settings, or a device without a vibrator, is reported
  (`suppressed` / `unavailable`). The `shutter` cue is `MediaActionSound`, `click` is the system
  click sound effect, and `send` / `receive` are short system tones; no audio is bundled, and the
  ringer (silent or vibrate) and the touch-sounds setting suppress them.
- **iOS haptics** use `UIImpactFeedbackGenerator`, `UISelectionFeedbackGenerator` and
  `UINotificationFeedbackGenerator` (doubleClick is two impacts 80 ms apart). The Simulator does
  not render haptics but the call still succeeds and is logged; "System Haptics" off and the silent
  switch are not detectable, so nothing is reported suppressed. Sounds are `AudioServices` system
  sounds (click 1104, send 1001, receive 1007, shutter 1108); `volume` is ignored and the host's
  `AVAudioSession` is never touched.
- **`feedbackLog`.** Each shown prototype keeps its last 64 calls, oldest first, and `prototype
  inspect` (and `status`) returns them as `feedbackLog: [{effect | sound, nodeId?, timeMs,
  suppressed?}]`. `nodeId` is the one node whose tap, long-press or double-tap action made the
  call, absent for a platform handler or when several nodes author the same call; `timeMs` is the
  device clock. Failed calls are not logged; a show or dismissal clears the log.
- **Device acceptance** is still open (`needs-device-verify`): an Android emulator tap appearing in
  `feedbackLog` and in `dumpsys vibrator_manager`, an iOS Simulator `feedbackLog` entry, and the
  feel on a physical device.

| Field                  | Rule                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call`                 | Required: `"<module>.<op>"` naming a call in `platformModules`, else `Unknown platform call` at `.call`. Its module must be listed in `requires.platform`, its permissions in `requires.permissions` and its background names in `requires.background`; each error is at `.call`.                                                                                                         |
| `args`                 | Up to `MAX_PROTOTYPE_PLATFORM_ARGS` (16) entries, exactly the call's declared arguments (`Unknown argument`, `Required argument` at `.args.<name>`). Each is a value binding: `{value}`, `{state}`, `{data}`, `{platform}`, `{item}` / `{index: true}` in a repeat, and `{event}` inside a handler. A literal `{value}` must satisfy the argument's rule (error at `.args.<name>.value`). |
| `into`                 | Optional `/data/<pointer>`, the `request` rule: an object member, not an array element, so `<into>__meta` can be written beside it. `/platform` is read-only, so an `into` under it is refused. Written with `applyPrototypeDataWrite` and reported as a `change` event.                                                                                                                  |
| `statusKey`            | A declared **string** state key, moved `loading` → `success` or `error`, as for `request`.                                                                                                                                                                                                                                                                                                |
| `timeoutMs`            | Optional integer, 1 to `MAX_PROTOTYPE_PLATFORM_TIMEOUT_MS` (300000, long enough for a system picker); the default is `DEFAULT_PROTOTYPE_PLATFORM_TIMEOUT_MS` (10000).                                                                                                                                                                                                                     |
| `onSuccess`, `onError` | Optional action lists (1 to 32). They count toward `MAX_PROTOTYPE_ACTION_DEPTH`.                                                                                                                                                                                                                                                                                                          |

A failed call writes `{code, message}` to `<into>__meta.error`, with `code` one of `unsupported`,
`unavailable`, `permission_denied`, `invalid_args`, `cancelled`, `timeout`, `too_many_in_flight`
(more than `MAX_PROTOTYPE_PLATFORM_CALLS_IN_FLIGHT`, 4) or `platform_error`.

**`requires`** is optional and strict. `platform` lists module names (1 to 32, unique, each in
`platformModules`, else `Unknown platform module`). `permissions` lists `{name, purpose}` entries
(1 to 16, names unique): `name` is one of the canonical permissions of #14297 (`camera`,
`microphone`, `location`, `locationBackground`, `notifications`, `photos`, `photosAdd`, `contacts`,
`calendar`, `bluetooth`, `nearbyWifi`, `motion`, `speech`) and `purpose`, a nonblank string of at
most 512 characters, becomes the iOS usage string and the Android rationale. `background` lists
the canonical background names of #14301 (`audio`, `location`, `call`, `connectedDevice`,
`transfer`, `camera`, `microphone`, `remoteNotification`). The host reads `requires` before show
for the gates below, and the disposable-app shell (#14184) derives its manifest and Info.plist from
it.

**Events.** `platform.on` maps `"<module>.<event>"` names (up to `MAX_PROTOTYPE_PLATFORM_HANDLERS`, 32) to action lists. An unknown event is refused at `platform.on["<name>"]`, and its module must be
declared. A handler runs atomically under the interaction lock, like a tap, and may use `push` /
`pop`, data and state actions and `platform` calls. Only inside a handler, `{event: "/pointer"}`
reads the delivered event's data, scoped the way `{item}` is scoped to a repeat; anywhere else it
is refused with `{event} is only available inside a platform.on handler`.

**Platform state** is device-owned JSON under `/platform/<module>/...` (for example
`/platform/permissions/camera`), at most `MAX_PROTOTYPE_PLATFORM_STATE_BYTES` (65536). It is read
with a `{platform:/pointer}` text placeholder, a `{platform: pointer}` value binding and a
`{platform: pointer, equals | notEquals | gt | lt}` condition, parallel to the `{data}` forms; the
pointer's first segment names the module, which must be declared. It is not patchable, not
storable and not part of the `/data` revision log.

**Reported events.** No wire field is added. A finished call is an `emit` named
`prototype_platform` with payload `{callId, call, outcome, error?, durationMs, simulated?}`, sent
after the `into`, `__meta` and `statusKey` writes and before `onSuccess` / `onError`. A delivered
event is an `emit` named `prototype_platform_event` with payload `{event, data, truncated?,
simulated?}`, `data` cut to the 4 KiB emit budget with `truncated: true`. Await them with
`awaitEvent {kind: "emit", eventName: "prototype_platform"}`; a malformed payload is dropped, as for
requests (`prototypePlatformEvent.ts`). Authored emit names cannot start with `prototype_`, which
generalizes the single reserved `prototype_request` name.

**Device state.** The `device` module exposes `/platform/device/widthClass` on both
platforms: Android reports Material `compact` (<600dp), `medium` (600–839dp), or
`expanded` (>=840dp); iOS reports `compact` or `regular` directly from
`horizontalSizeClass`, independent of window width. There is no `sizeClass` key;
`heightClass` and `posture` remain Android-only. Declare `device` in
`requires.platform` and branch on `/device/os` for platform-specific layouts.
The contract's `value` rule supplies the default and `valueByPlatform` overrides
it for the named platform. Spec validators have no target-platform input and
accept the union of those rules for `equals` and `notEquals`, so portable specs
can contain branches for either platform. Consequently, an `expanded` comparison
is valid portable syntax even when loaded on iOS; it never matches an iOS snapshot.

**Capabilities.** `prototype_platform_v1` gates `requires`, `platform.on`, the `platform` action and
`{platform}` reads; each module adds `prototype_platform_<module>_v1`, and a later op or event gets
a `_v2` gate that checks the fields that version introduced. The gates are generated from
`platformModules` and join `PROTOTYPE_SPEC_CAPABILITY_GATES`, so show, patch and `replaceNode`
refuse uniformly. Because every module use must be declared in the root `requires`, which a patch
cannot add, a patch never introduces a module the shown spec did not already require.

Android's renderer accepts an identity-stable `PrototypePlatform` containing an immutable module
registry. The host supplies modules; it retains ownership and closes them after all surfaces detach.
The built-in device module projects the host's measured window state. Each surface subscribes to
module state and events, and the controller shares a four-call limiter across its surfaces. Calls
resolve arguments at invocation, wait outside the interaction lock, and commit result, metadata,
status, outcome event and follow-ups under that lock. Replacement, reset and dismissal cancel calls;
cancellation reports an outcome without running follow-ups. CtrlProxy registers only the device
module in release; debug additionally registers the permission-free test module.

The shared fixtures `test/fixtures/prototype-spec/valid/platform-*.json` and
`invalid/platform-*.json` are replayed by the TypeScript, Kotlin and Swift validators.

### Conditions

A condition is exactly one of these forms. `visibleWhen` takes any of them;
`bottomSheet.openWhen` keeps the boolean `{key, equals}` form.

| Form                        | Holds when                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `{key, equals: scalar}`     | The state value is exactly equal (same type). A missing key never holds.              |
| `{key, notEquals: scalar}`  | The state value differs, including when the key is missing.                           |
| `{key, gt: number}`         | The state value is a number greater than `gt`. Any other type is false.               |
| `{key, lt: number}`         | The state value is a number less than `lt`. Any other type is false.                  |
| `{key, contains: string}`   | A string state value contains the operand, case-sensitive UTF-16 units.               |
| `{key, startsWith: string}` | A string state value starts with the operand, case-sensitive UTF-16 units.            |
| `{key, lengthGt: integer}`  | A string state value has UTF-16 length strictly greater than the operand.             |
| `{key, lengthLt: integer}`  | A string state value has UTF-16 length strictly less than the operand.                |
| `{valid: key or keys}`      | All referenced keys pass their checks.                                                |
| `{data \| platform, ...}`   | `equals`, `notEquals`, `gt`, `lt` on `/data` or `/platform`; `empty` only on `/data`. |
| `{all: [condition, ...]}`   | Every member holds. One to 16 members.                                                |
| `{any: [condition, ...]}`   | At least one member holds. One to 16 members.                                         |
| `{not: condition}`          | The member does not hold.                                                             |

String comparisons require `prototype_string_conditions_v1` and are key-only. Missing and non-string values fail all four. `contains`/`startsWith` literals are nonempty, at most 256 UTF-16 units; operands bind repeat `{item.x}`/`{index}` placeholders as text (a numeric item renders as its text, unlike `equals`). An empty substituted operand holds for every string. No Unicode normalization is performed. `lengthGt`/`lengthLt` are literal integers in 0..100000; equality to the length fails both, and `😀` has length 2.

Numbers compare by value, so a state of `-0` equals `0` on every platform (#11408).

Conditions nest to a depth of 8 (`MAX_PROTOTYPE_CONDITION_DEPTH` in the shared
contract). Every key/data/platform form takes exactly one comparison; string comparisons require `key`;
errors point at the offending field (for example `root.visibleWhen.gt`).
`toggle`, `increment` and `decrement` validate their `key` against the declared `state`
(`root.onTap[0].key`), and are no-ops at runtime if the key's type was changed by
other means. After an `onTap` action list finishes, if `setState`, `toggle`,
`increment` or `decrement` changed state, the device emits exactly one `change` event carrying
the final state (#10622), so host `status` follows button taps. A single changed
key sends `{key, value}`; several send `{keys, values}`. `emit` actions still fire
in order with the state at that point, a list that nets no change emits nothing,
and a switch or checkbox tap keeps its own `{key, value}` change before its
`onTap` runs. Wire patches from the host stay silent.

An action list is atomic on Android (#11408). The runtime re-validates the state every
write would leave (binding types, numeric ranges, the size cap) before the first action
runs; if any write is rejected, nothing in the list is applied and nothing is emitted,
so device state and the host's event-fed copy never drift apart. Actions after a
`dismiss` never run and are not checked. A control's own write (a switch flip, a chosen
option, a slider value, a picked time, a tab selection, a dialog close) is part of the
same unit as its `onTap` list: a rejected list leaves the control's value and a bound
pager's page untouched too. An accepted control still reports its own `change` first
and then its list, as the iOS agent does. A rejected interaction is logged on the device
only; no event or status field reports it, so the host sees nothing change. The iOS
agent does not re-validate at runtime, so the same list applies there in full with
one `change`; the TypeScript host and Kotlin validators refuse at `show` a `setState` whose
value type does not fit a control bound to the key (#11452), which closes that gap on the host.

### Conditional style: styleWhen

Any node may declare `styleWhen`: one to 8 entries of `{when: condition, style: style}`
(for selected, disabled or error looks without duplicating nodes). `when` takes
any condition form above; `style` is the same strict style object as `style`, so
an unknown key fails at `root.styleWhen[0].style.colour`. At render, every entry
whose condition holds is merged over the node's base `style` in authored order:
a property set by a later matching entry wins, and properties no entry sets keep
the base value. Merging is per top-level property, so `padding`, `border`, `offset` and a
per-corner `cornerRadius` replace the base object whole rather than merging field
by field. Conditions read the
node's local state, so pager `{page}`/`{pageCount}` keys work inside a pager.

### List templates: repeat

A `box`, `row` or `column` may declare `repeat: {items, as}` to render one template
per item without writing every row out. The container's `children` are the
template: they are instantiated once per entry of `items`, in item order, as
siblings inside the same container (the container itself is not repeated, so a
list is a `column` with `repeat` whose single child is the row template).
`items` holds 1–128 entries, and the expanded tree still counts against
`MAX_PROTOTYPE_NODES`.

```json
{
  "type": "column",
  "repeat": {
    "items": [
      { "name": "Alpha", "tag": "a" },
      { "name": "Beta", "tag": "b" }
    ],
    "as": "item"
  },
  "children": [
    {
      "type": "text",
      "text": "{index}: {item.name}",
      "styleWhen": [
        { "when": { "key": "picked", "equals": "{item.tag}" }, "style": { "color": "#2255CC" } }
      ],
      "onTap": [{ "type": "setState", "key": "picked", "value": "{item.tag}" }]
    }
  ]
}
```

- `items` is a literal array of 1 to 32 objects declared in the spec. Each object
  maps state-style field names to scalar values (string, finite number, boolean);
  no nesting. `as` names the item binding (a state-key-shaped identifier). State
  values are scalar, so a state key cannot hold a list; per-state-key lists are not
  supported.
- Placeholders are `{index}` (the zero-based position) and `{<as>.<field>}`. They
  are bound in a template child's `text`; in the component fields `button.label`,
  `fab.label`, `segmentedButton.options[].label`, `topAppBar.title`,
  `topAppBar.navigationIcon`/`actions[]` (`label` and their `onTap`), `dialog.title`,
  `dialog.text`, `dialog.confirm`/`dismiss` (`label` and `onTap`), `snackbar.text` and
  `snackbar.action` (`label` and `onTap`); in condition operands (`equals` and
  `notEquals` strings in `visibleWhen`, `styleWhen[].when` and nested `all`/`any`/
  `not`), in `setState.value` and in `emit.name`; and in every state key (#11051):
  `stateKey`, `timePicker` `hourKey`/`minuteKey`, a `listItem` trailing `stateKey`,
  `openWhen.key`, condition `key`s and the `key` of `setState`, `toggle`, `increment`
  and `decrement`, so `"key": "liked_{item.id}"` gives every row its own state.
  Anything else, including a
  `{key}` state placeholder, other braces, and the container's own fields, is not a
  repeat placeholder and is untouched. Inside a template `{index}` shadows a state
  key named `index`. A string that is exactly one placeholder keeps the item's own
  type, so `equals: "{item.id}"` matches a numeric state value when `id` is a number;
  a placeholder inside a longer string renders to text (integral numbers without a
  decimal point). `emit.payload` is not interpolated. Bound values are plain text, but a
  `text` node is then interpolated against state as usual, so an item string that itself
  reads `{status}` shows the state value; item values cannot be escaped.
- Validation, with the same paths in TypeScript and Kotlin: a placeholder naming a
  field that is missing from any item fails at the string (for example
  `root.children[0].text`, message `Unknown repeat field "nme"`); a template may not
  contain another `repeat` (`root.children[0].repeat`) or a `pager`
  (`root.children[0]`); `repeat` on a leaf node is an unknown property; an `emit.name`
  that binds to an empty string for any item fails at the name (`root.children[0].onTap[0].name`).
  A bound state key must be a literal key (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`) for every
  item; one that is not fails at that item (`root.repeat.items[1]`, message
  `Bound state key "liked_b-c" is invalid`). A state-key
  placeholder outside every template fails at the key (`State key placeholder outside a
  repeat template`). A bound key missing from `state` behaves exactly like a literal
  missing key: the type checks run once per item and fail at the key, naming the item
  (`Toggle requires a boolean state key (repeat item 1)`).
- Limits count the expanded tree. `MAX_PROTOTYPE_NODES` and `MAX_PROTOTYPE_IMAGES` are
  checked against every instance, and an overflow fails at the container's
  `repeat` (for example `root.children[2].repeat`, `Expanded node limit exceeded`).
  `MAX_PROTOTYPE_DEPTH` is unaffected by design: instances are siblings, so a
  template child is exactly as deep as it was written. Because items are literal,
  all of this is decided statically; the renderer re-checks the expanded count
  before layout as a backstop.
- Rendering expands the template before layout. Each instance node renders under
  the path `container.repeat[item].children[template]`, which is also its Compose
  key, so a row keeps its identity for as long as it keeps its index.

### Reusable components: components and use

A spec may declare a top-level `components` map of named node templates and place
them with `use` nodes (#11053), so a card, row or header used in several places is
written once.

```json
{
  "components": {
    "postCard": {
      "root": {
        "type": "card",
        "children": [
          { "type": "text", "text": "{props.name}" },
          {
            "type": "button",
            "label": "Like",
            "onTap": [{ "type": "toggle", "key": "{props.likeKey}" }]
          }
        ]
      }
    }
  },
  "root": {
    "type": "column",
    "children": [
      {
        "type": "use",
        "component": "postCard",
        "props": { "name": "Alexey", "likeKey": "liked_a" }
      },
      { "type": "use", "component": "postCard", "props": { "name": "Bea", "likeKey": "liked_b" } }
    ]
  }
}
```

- Components are expanded on the host (`src/features/prototype/prototypeComponents.ts`)
  before validation and transport: each `use` is replaced by a copy of the
  component's `root` and `components` is dropped. Devices never see either, so the
  Kotlin and Swift renderers and the device validator are unchanged.
- Component names and prop names are state-key-shaped. A `use` node has only
  `type`, `component` and optional `props`; props are scalars (string, finite
  number, boolean).
- `{props.<field>}` binds in exactly the fields a `repeat` placeholder binds (see
  List templates above), state keys included, plus the `props` of a nested `use`.
  A string that is exactly one placeholder keeps the prop's type. `{index}` and
  other aliases are left for a `repeat` to bind, so a `use` inside a repeat template
  can pass `"likeKey": "liked_{item.id}"`, and a component may contain `repeat`
  and further `use` nodes.
- Rejected, with the path of the `use`: an unknown component
  (`root.children[0].component`), a missing prop (`.props`), an unused or
  non-scalar prop (`.props.<name>`), a cycle including self-reference
  (`.component`, message `Component cycle: a → b → a`), and `use` nesting deeper
  than 8. Unused components are allowed.
- Limits apply to the expanded tree: nodes, depth and images as usual (expansion
  itself stops at `MAX_PROTOTYPE_NODES`), and the byte limit applies to both the
  authored and the expanded spec (`Expanded spec byte limit exceeded`), because the
  device re-validates bytes.
- An error inside an expansion names each `use` it went through, for example
  `root.children[2] (use postCard) → components.postCard.root.children[1].label`.
  Nodes outside every component keep their authored paths, because a `use` expands
  to exactly one node.

### Patch (#11675)

Use `show` for a new screen or a window, theme or root change. Use `patch` for
content (`/data`), state (`/state`) or one node by id (`replaceNode`). Android CtrlProxy advertises
`prototype_patch_v1` and applies patches in place; the iOS prototype agent advertises it too
(a relaunched app loads the current agent), so an older agent still needs the whole spec with `show`.

`{action:"patch", id, ops, baseRevision?}` sends a `patch_prototype` frame
`{requestId, id, baseRevision?, ops}` only to a device advertising
`prototype_patch_v1`. Android and iOS use `prototype_result` replies. Success
carries `revision`; a state conflict carries
`{success:false,error,conflict:{revision,state:{key:scalar}}}`. Revisions are
non-negative safe integers; conflict values are strings, booleans or finite
numbers with valid state keys. Malformed reply fields are dropped. Show, status,
inspect and events do not report revisions through this host contract.

Ops apply in order, completely or not at all. `add`, `replace`, `remove` and
`test` address `/data` or `/data` followed by an RFC 6901 JSON pointer: `~0`
escapes `~`, `~1` escapes `/`; array indices are canonical non-negative decimal
integers, and `-` appends for `add` only. Parent paths must exist. `replace`,
`remove` and `test` require the addressed value to exist. `add`, `replace` and
`test` carry `value`; `remove` does not. State ops address exactly
`/state/<key>`, where keys match `[A-Za-z_][A-Za-z0-9_]{0,63}` and values are
strings, booleans or finite numbers.

`replaceNode` carries `{op:"replaceNode",id,node}`. The id must identify exactly
one node in the tree, cannot be the root or inside a repeat, and the replacement
must keep that id. Replacement nodes cannot contain `use` nodes or element
anchors. Inline the component, use a bounds anchor, or use `show`.

The agent writes data; the user writes state. Data-only patches and patches
containing only data ops and `replaceNode` ignore `baseRevision`, until the device has written the
prototype's data with a data action (see [Data actions](#data-actions-12519)): from then on a
`/data` op also needs `baseRevision` and conflicts with newer overlapping device writes. Any state
op, including `test`, requires `baseRevision`. A device supporting the capability
must refuse the whole patch with `conflict` if the user changed a touched state
key since that revision, returning the current revision and those keys' values.

There are at most 64 ops, the frame is capped at 1 MiB, and the resulting whole
spec must satisfy every spec/data limit, including node count and depth. The
host tracks a cloned copy of each id's device spec from its last acknowledged show,
with components expanded and anchors resolved. It applies ops to a copy and
runs the full validator before sending. Errors preserve deterministic paths.
The host validates state ops against the agent-declared state and leaves value
comparison for `/state` `test` to the device; its copy cannot know user edits.

Patches are FIFO per device, one in flight at a time; a pending show makes patch refuse as busy, and shows are not delayed by patches. If a dispatched show and an acknowledged patch overlap, their device-side order is unknown: the host forgets its spec, warns, and requires a further successful show before patching. A failed dispatched show, dismissed event, successful dismiss, session release, device removal or unbinding also ends tracking. Inspect retains each reported tracked id and drops missing ids (adopted siblings do not end tracking); a fifth-surface refusal with `replaceOthers: false` retains the acknowledged specs. A timeout or connection loss after dispatch is indeterminate and requires a new show; a failure before dispatch keeps the tracked copy; an atomic device refusal leaves it unchanged. A successful patch refreshes shown status data without changing `lastResult`, timestamps or event snapshots.

### Re-showing a prototype

`show_prototype` always carries a full spec; `patch_prototype` is the gated content/state/node contract (#11675).
When `spec.id` is the prototype already on screen and `reset` is absent or false,
the device replaces it in place: it keeps the display the prototype is on (the
request's `displayId` is ignored), and each pager keeps its settled page,
matched by pager id and clamped to the new page count. The new spec's `state`
is authoritative; values the user changed by tapping or typing are not carried
over unless the spec includes them, except the keys its `storage` block lists, whose
stored values replace the spec's (see [Storage](#storage-12522)). The window content is rebuilt from the new
runtime, so a text field shows the spec's value and edits still in flight from
the previous showing are dropped. Event sequences continue per id, as for any
re-show. `reset: true`, a different id, or nothing on screen is a fresh show:
pages start from the spec and the requested display is used. `reset` is only
sent when true; a device that predates it ignores the field and always starts
fresh. The host reports a `display` that a same-id show ignored as a `warning`
on the tool result.

### Presenting alternatives

The host has no carousel helper (`showVariants` and its on-device pick were removed, #10489, #10488). Show
one design with `show` and discuss the others in chat, or show one spec whose `pager` holds every design
with a visible label per page (see the full-screen pager example). Nothing waits on the device for a
choice.

### Loopback requests from the device (#12530)

On an Android emulator or device, `localhost` in a `request` action with `via: "device"` is the
device itself, not the host. When the host shows a prototype it scans every such request, at any
depth (including nested `onSuccess`/`onError` lists), for URLs on `localhost`, `127.0.0.1` or `[::1]`
and runs `adb -s <serial> reverse tcp:<port> tcp:<port>` for each port. `via: "host"` requests are
ignored.

- Implicit ports are reversed: `http://localhost/` reverses 80 and `https://localhost/` reverses 443,
  so the same URL reaches the same host server under both `via` values.
- Ownership: a reverse is recorded as the host's own only when it created it. One already listed by
  `adb reverse --list` is left alone and never removed. Ports are reference-counted across the
  prototypes shown on one device and removed when the last holder is dismissed, the session ends, or
  the device is unbound or removed.
- Best-effort: a failed reverse is logged and reported as `reverseFailures`; it never fails the show.
- A port that is a binding (`http://localhost:{port}/feed`) or an unparseable URL cannot be
  reversed, because it is unknown until the request runs. `inspect` reports these as
  `unreversiblePorts`, and the authoring guide says to use `via: "host"` for them.
- A saved prototype launched with no host connected has no host to run `adb reverse`, so its
  `via: "device"` requests to localhost fail until a host shows or re-shows it. Use a reachable
  address (or `via: "host"` while a host is attached) for prototypes meant to run unattended.
- iOS simulators share the Mac's network, so nothing is reversed there. The iOS agent refuses
  loopback destinations for `via: "device"`; see the iOS
  [destination policy](../ios/prototype-agent.md#destination-policy-13815).

## Realtime channels

The strict root `channels` map declares up to four channel IDs (state-key grammar) and requires
`realtime` in `requires.platform`. Channel declarations, realtime calls and realtime state reads
require `prototype_platform_realtime_v1`. `via: "device"` additionally requires
`prototype_platform_realtime_device_v1`. Neither runtime advertises these capabilities.

A channel requires `kind: "websocket" | "sse"` and `url`. WebSocket URLs use ws/wss; SSE URLs
use http/https, sharing request URL placeholder and length rules. Optional `protocols` has up to
four unique WebSocket subprotocols, each an RFC 7230 token of 1..64 characters. `headers` has up to 16 entries and shares the request rules, also
refusing case-insensitive `Sec-WebSocket-*` and `Last-Event-ID`. Optional `via` defaults to host,
`connect` to onShow (or manual), `decode` to json (or text); `statusKey` names declared string
state. `reconnect` requires integer maxAttempts 0..20 and initialDelayMs/maxDelayMs with
100 <= initial <= max <= 60000.

Up to 16 ordered routes match `{pointer, equals}`, `{pointer, exists: boolean}`, an SSE event
name `{event}`, or every frame when `when` is absent. Routes allow state and data actions only;
requests, navigation and other effects are refused. Routes and onOpen/onClose/onError callbacks
have handler event scope: `{event: ""}` reads the whole event and a nonempty RFC 6901 pointer
reads a member. Root `platform.on` supports realtime.status and realtime.frame as well.
`realtime.connect/disconnect` take a declared channel selector; `realtime.send` also takes a body
value binding and requires a WebSocket channel. A selector is a literal string or `{value: id}`. Literal argument strings are nonempty and
limited to 64 UTF-8 bytes; declared IDs use the ASCII state-key grammar, so their byte and
character limits coincide. Dynamic channel selection is refused so validation can prove the
declaration and kind.
Callbacks refuse requests, navigation and realtime.connect, including in nested action lists;
realtime.send and realtime.disconnect remain allowed. Library bundles refuse host channels
(including the default via) and secure state bindings in channel URLs, headers and action payloads,
using the request library policy.

The read-only `/platform/realtime/<channel>` state contains status, attempt, framesIn,
framesDropped, closeCode, closeReason and error, read through `/realtime/<channel>/<field>`
platform pointers. The contract budgets are 65536 bytes per received frame, 16384 per send,
eight open channels per device, and 50 ms per flush window. Literal send bodies are checked
statically using UTF-8 string bytes or compact JSON bytes. Limits are read from the shared
contract by the TS, Kotlin and Swift mirrors.

The realtime capability gates `{event}` and `{platform}` values in setState, setData, appendData,
prependData and upsertData, plus whole-event `{event: ""}` arguments to platform calls. Existing
nonempty event arguments, platform arguments and platform conditions retain their existing gates.
Known limit: static validation checks event scope and platform pointer declarations but skips
source-to-target type checks for these two dynamic binding forms; the receiving runtime must
validate the resolved value before applying a write or call.

The realtime capability also gates `appendData.maxItems` and `upsertData {path, key, value,
maxItems?}` everywhere actions can occur. Upsert replaces the first matching identity in place
or appends; the incoming value must contain its valid, nonempty key pointer. A literal value is
refused statically when that pointer is missing or resolves to null. JSON identity uses
numeric value, exact strings and member names, and structural array/object equality. maxItems
is an integer 1..2000; oldest rows are dropped after replacement/append and before final data
limits. Missing/non-array targets and invalid writes leave input unchanged.

The daemon holds the upstream connection for `via: "host"` channels (see
[Host channel transport](#host-channel-transport)). Runtime work remains owed: the device-side
transports, device client frame routing, routing and atomic frame writes, reconnect/backoff, send queues, counters/events, inspection, simulation and
foreground/background/patch/reset/dismiss lifecycle. Pure TS, Kotlin and Swift rules replay shared
backoff and coalescing vectors under `test/fixtures/prototype-spec/realtime/`. Reconnect uses
full jitter: `floor(random * min(maxDelayMs, initialDelayMs * 2^(attempt-1)))`, with defaults of
8 attempts, 500 ms initial delay and 30000 ms maximum delay; exhausted attempts consume no
random value. Within one 50 ms flush window, consecutive frames made only of `setData` and
`setState` to the same set of targets collapse to the last frame. Appends and all other actions
remain ordered and are never coalesced. These are contract rules without runtime integration.

### Host channel transport

A `via: "host"` channel is a relay: the device sends `prototype_channel_open {connectionId,
prototypeId, channel, kind, url, protocols?, headers?, lastEventId?}` and the host answers with
`prototype_channel_opened`, one `prototype_channel_frame {data, event?, id?}` per upstream frame
and a final `prototype_channel_closed {code?, reason?, error?}`. The device sends
`prototype_channel_send {connectionId, data}` and `prototype_channel_close`. These are transport
messages outside the Kotlin-mirrored wire manifest; what a spec sees stays on
`prototype_platform_event`. The host never reconnects: the device state machine owns backoff, so
`via` does not change behaviour.

- **Egress.** The destination goes through the same pinning as requests: localhost names, every DNS
  answer and the daemon's own ports are checked, and the socket connects only to the validated
  address while keeping the URL's `Host` and TLS server name. A refusal is `blocked_destination`.
  Authored headers follow the request rules, and `Sec-WebSocket-*` and `Last-Event-ID` are refused.
- **WebSocket.** A handshake redirect or any non-101 answer is `handshake_failed` with the HTTP
  status. Binary frames are not delivered. A ping goes out every 25 s and a missed pong closes the
  connection with `network`.
- **SSE.** A `GET` with `Accept: text/event-stream` and `Last-Event-ID` when the device supplies
  one. Redirects are re-validated at each hop (at most five; an origin change drops authored
  headers; an HTTPS-to-HTTP hop is refused). Anything but a `200 text/event-stream` answer is
  `handshake_failed`. Events follow the WHATWG EventSource processing model; `retry` is ignored,
  since the device owns the delay. The stream has no total size cap, only the per-event cap.
- **Limits.** The handshake times out after the request default. A frame or event larger than
  `MAX_PROTOTYPE_CHANNEL_FRAME_BYTES` closes the connection with `too_large` (the host cannot
  drop one frame and keep the stream aligned). A device send larger than
  `MAX_PROTOTYPE_CHANNEL_SEND_BYTES` is refused, and a device may hold at most
  `MAX_PROTOTYPE_CHANNELS_OPEN` connections; one over the cap is answered with `closed` and
  `too_many_in_flight`.
- **Lifecycle.** Dismissing the prototype, closing the owning socket or removing the device aborts
  its connections without a `closed` frame, as a cancelled request sends no reply. A socket close
  ends only the connections it opened.

### Mock backend

A prototype can talk to a declarative backend with no server code (decisions in
`docs/decisions/prototype-mock-backend.md`). A request whose URL host is
`<backendId>.mock.automobile.invalid` is answered in process by the daemon's backend of that id,
before the egress policy: no DNS lookup, socket or `adb reverse`. A host under that suffix that
names no defined backend fails as `network`. Backends live for the daemon session and are bounded
(16 backends, 16 collections, 64 routes, 1 MiB of collections and routes).

- **Collections** are json-server style: `GET /<name>` filters by `?field=value`, `q` matches a
  case-insensitive substring of any string or number member, `_sort=price|-price` sorts stably
  (numbers numerically, strings by code point), `_page` and `_limit` page (default limit 10, at most 100) with an `x-total-count` header, and `after` and `size` cursor-page into `{items, next}`.
  Every defined item needs an id (a number, or a non-empty string other than `.` and `..`, which URL
  normalization would turn into path navigation) so a path and a cursor can both name it.
  `GET /<name>/:id`, `POST` (201, id from the injected id generator when absent, 400 on an invalid id, 409 on a duplicate),
  `PATCH` (shallow merge), `PUT` (replace) and `DELETE` complete the surface; an item's id never
  changes, and a write that would exceed the size budget is refused with 413 and changes nothing.
- **Routes** are canned responses `{method, path, status?, headers?, body?, delayMs?}` that win over
  collections. A path is literal segments and `:name` parameters. Bodies bind `{params.x}`,
  `{query.x}` and `{body:/pointer}`: a string that is exactly one placeholder takes the value's
  type, a placeholder inside text interpolates, and an unbound one is `null` or empty.
- **Latency and faults** draw from the backend's seeded random stream and wait on the injected
  timer, so a run replays identically: `latencyMs {min, max}` delays every answer, and each fault
  `{path, method?, status, every | rate}` fires on every nth matching request or with probability
  `rate`, answering `{error: "mock fault"}`.
- Every answered request is logged (latest 200, with a sequence number) for assertions.

The `prototype` tool drives it with host-local actions that make no device request: `defineBackend
{backendId, backend}` validates the definition and replaces the backend of that id (a failed
definition leaves the old one), `clearBackend {backendId}` removes it, and `backendLog {backendId,
since?}` returns the log. Their results report the origin a spec should call. `show` takes `mock`
(`{backendId: definition}`) or `mockPath` (an absolute file of the same, read like `specPath`, up to
2 MiB): after the spec passes validation, every entry is validated and defined or none is, replacing
backends of the same id. A saved prototype does not carry its mock backends. A request that
carries a `timeoutMs` is bounded by it like any host request, and a request that times out or is
cancelled while waiting on latency never writes to the backend.

## Data, storage and network (#12531)

The three features compose: a `request` writes its response into `/data`, data actions edit `/data`
from a tap, and `storage` makes chosen `state` and `/data` values survive a re-show or relaunch.
The detailed contracts are [Data actions](#data-actions-12519), [Storage](#storage-12522) and
[Request action](#request-action-12523); this section is the one-page overview and the capability
map.

| Capability                              | Gates                                                     | Android CtrlProxy | iOS agent     |
| --------------------------------------- | --------------------------------------------------------- | ----------------- | ------------- |
| `prototype_data_actions_v1`             | `setData`, `appendData`, `prependData`, `removeData`      | Advertised        | Advertised    |
| `prototype_storage_v1`                  | root `storage` block, `inspect` `storage`, `clearStorage` | Advertised        | Advertised    |
| `prototype_network_v1`                  | the `request` action with `via: "host"`                   | Advertised        | Advertised    |
| `prototype_platform_realtime_v1`        | channels, realtime calls, upsertData, appendData.maxItems | Contract only     | Contract only |
| `prototype_platform_realtime_device_v1` | channels with `via: "device"`                             | Contract only     | Contract only |
| `prototype_network_device_v1`           | `request` with `via: "device"`                            | Advertised        | Advertised    |

A device without a capability is refused before uploads or show, with a message naming the
capability. Device-side verification is the manual run in `skills/manual-test/prototype-acceptance.md`
("Data, storage and network").

Behaviour per feature lives in the sections above: a data write bumps the data revision and emits one
`change` named for the path; storage precedence is the six rules under Storage; the request lifecycle
(`statusKey`, `<into>__meta`, atomic completion, latest-wins cancellation, `prototype_request` event) is
under Request action.

**The two transports.**

- `via: "host"` (the default): the device sends a `prototype_request` frame and the host runs the
  HTTP transport, with an egress policy checked before every connection and redirect. The host needs a
  connection; with none the request fails with `network`. Closing the owning connection fails its
  calls at once, and a cancelled call sends `prototype_request_cancel` so the host frees the slot.
- `via: "device"`: the device runs the request itself. On Android `localhost` is the device, so the
  host runs `adb reverse` for each loopback port it finds in the shown spec (see
  [Loopback requests from the device](#loopback-requests-from-the-device-12530)); on an iOS
  simulator nothing is reversed and the agent refuses loopback destinations (see the iOS
  [destination policy](../ios/prototype-agent.md#destination-policy-13815)).

**Host egress policy.** Host requests refuse localhost names, loopback, unspecified and link-local
addresses, emulator host aliases, and IPv6 forms embedding those IPv4 destinations.
SIIT and both NAT64 prefixes use the embedded IPv4 classification;
Teredo and site-local IPv6 addresses are refused. Every DNS
answer must be permitted; the connection is pinned to a validated IP while retaining the original
HTTP authority and TLS hostname. Daemon HTTP ports (including the configured port and fallback
range) and CtrlProxy's port are refused on private addresses; public addresses remain permitted on
those ports. Redirects are checked at each hop (at most five); HTTPS-to-HTTP redirects are refused.
An origin change removes all authored headers. Host, connection/framing, Cookie, Origin and Proxy-
headers and Expect are not accepted from requests. Other RFC1918 destinations remain permitted
on ordinary ports, including `10.1.2.3` and `192.168.1.10`.
A policy refusal is `blocked_destination`: the destination
is not permitted. Device requests retain their platform transport behavior.

The host transport makes a direct connection. Node uses a fresh agent with an empty `proxyEnv`,
ignoring HTTP(S)_PROXY, ALL_PROXY and NO_PROXY routing configuration. Bun refuses the request
before connecting if any nonempty HTTP_PROXY, HTTPS_PROXY or ALL_PROXY variable is present
(case-insensitive), even with NO_PROXY set; NO_PROXY alone is permitted. That refusal is a
`network` outcome. Environment variables are never changed during a request.
For gzip, deflate and Brotli responses, the size cap applies to decoded bytes; the returned
headers omit content-encoding and content-length because they describe the encoded body.

**Cleartext and transport security.** CtrlProxy declares `INTERNET` and a `network_security_config`
with cleartext permitted, so `http://` works for `via: "device"` on Android. On iOS, `via: "device"`
runs inside the target app and obeys its App Transport Security: IP addresses are exempt (`localhost`
is too, but the agent's destination policy refuses it), other cleartext hosts fail with `network` and a message pointing to `via: "host"` or `https://`.
`via: "host"` is not subject to ATS.

**Saved prototypes.** A saved Android prototype (see
[Saved prototypes on the Android home screen](#saved-prototypes-on-the-android-home-screen)) supports
`request` actions with `via: "device"` (it still needs a reachable URL, since no host runs `adb reverse`
when it launches alone). `via: "host"` has no host to run it there, so it fails with an `invalid_request`
error whose message points to `via: "device"`.

**Limits.**

| Limit                                        | Value                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/data` write (after any action or response) | `MAX_PROTOTYPE_DATA_WRITE_BYTES`, 786432 bytes of data cost                                  |
| Response body                                | `MAX_PROTOTYPE_RESPONSE_BYTES`, 262144 bytes, 2xx only (a non-2xx body is never read)        |
| Request `timeoutMs`                          | 1 to 30000, default 10000                                                                    |
| Requests in flight                           | 4 per device                                                                                 |
| Header and query entries                     | 16 each, values up to 4096 characters                                                        |
| Storage                                      | at most 64 keys, 262144 stored bytes per prototype id                                        |
| Emit payload                                 | 4096 bytes; a larger `change` event drops its `value` and the host stops mirroring that spec |

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
rejection. Container chains have a separate `MAX_PROTOTYPE_SELECTOR_DEPTH` of 8;
the first container has depth 1. The existing TypeScript
`ElementContainerSelector` type is reused. Strings are preserved as authored. Alignment is required: `cover`, `top`, `bottom`,
`start`, or `end`; optional offset defaults to zero. Cover adopts target bounds;
edge alignment aligns the same node edge to the target edge, centered along the
other axis, preserving authored node dimensions, then applies the offset.

The host resolves selectors against the app hierarchy with the prototype excluded,
using tap's resolution (a text match is promoted to its clickable owner) with
`unique` selection, and converts the element's px bounds to dp once with the
display density the capture reports (`px * 160 / densityDpi`). Resolution happens at
show, not live. A missing, ambiguous (candidates listed), empty or off-screen element
fails the call before anything is shown. The result reports `anchors` (each anchored
node's path with the element's px and dp bounds) and `hierarchyUpdatedAt`; show again
to re-anchor after the app scrolls or re-lays out.

On the wire the device only receives bounds anchors: the host replaces each element
anchor with `{ "type": "bounds", "bounds", "alignment", "offset"? }`, keeping its
alignment and offset. A bounds anchor may also be authored with `alignment` (default
`cover`) and `offset`. The renderer refuses an element anchor that reaches it
unresolved. A host only sends anchors to a CtrlProxy advertising `prototype_anchor_v1`;
older APKs decode and ignore them, so the host refuses the show there. Element anchors
resolve against the default display (another `display` is refused). On an iOS simulator
the injected prototype agent positions anchors too, advertising the same
`prototype_anchor_v1` capability in its handshake; there, hierarchy bounds and spec sizes
are both points, so nothing is converted (see the
[iOS prototype agent](../ios/prototype-agent.md#anchors)).

The renderer lays an anchored node at its screen rectangle by subtracting the window's
screen origin and the node's own position inside the window (cutout, system bars, the
fullscreen host row, safe-area and authored padding). An anchored node below the root
is drawn in a window-level layer above the author tree (modal content: above its modal),
so its parent neither reserves a slot for it nor clips it, and its touch target and
accessibility bounds are where it is drawn (#10803). It is shown while all its
ancestors are; it does not inherit their opacity. Cover sizes the
node to the bounds, ignoring authored width/height. Window size is determined by
placement/content, not by implicitly resizing to an anchor:

- fullscreen and sheet windows take anchors on any node; content outside the window
  (above a bottom sheet, or under the fullscreen host row) is clipped;
- a floating window moves onto its anchored root (top-start gravity, x/y in screen px)
  and stays content-sized, so the rest of the app remains touchable. Only the root of a
  floating window may be anchored; the host refuses an anchor below it.

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

## Wear OS (not device-verified)

Prototypes render on a watch with the same overlay and Material 3 components as on a phone; the
spec has no round-aware nodes, Wear components or rotary input.

- On a device whose `formFactor` is `watch`, a successful `show` reports `screenRound`, read from
  `dumpsys display` like `observe`'s `isScreenRound`. Content in the corners of a round display is
  clipped. Other devices pay no read; an unreadable display leaves the field absent.
- The dismiss affordance keeps its phone placement; it is not moved into the round display's
  inscribed area.
- Wear launchers are not expected to support pinned shortcuts, so `save` with `pin:true` takes the
  unsupported-launcher path: the save is kept and the result reports `pinned:"unsupported"`.

## Lifecycle and safety

#12064 reverses the #9307 "non-removable dismiss control" default: chromeless fullscreen is the default on
a device advertising `prototype_window_chrome_v1`, and the bar is opt-in. The host escape is a stationary
two-finger long press (1 s) anywhere on the window that cancels authored touch handling for that gesture and
reveals a small dismiss pill for 5 s (a second hold restarts the timeout; a replacing show hides it). A
host-owned wrapper exposes the `Dismiss AutoMobile prototype` accessibility dismiss action without touch,
and touch exploration (TalkBack) keeps the pill permanently visible. Both dismiss with reason `user` and
stay usable at spec opacity 0. Back is not the exit: it only dismisses while a text field makes the window
focusable. Agent dismiss, a replacing show, authored dismiss, the five-minute idle TTL, last-client
disconnect and service teardown keep working. Home hides a session prototype when its app leaves the
foreground. A CtrlProxy without the capability keeps the bar and the host refuses explicit `none`.

Two safety cases still need device verification: 3-button navigation with
`layer: "system"`, and a prototype shown with no application window in front
(which Home does not hide).

With `none`, authored content fills the window including under the status bar (top content needs top-edge
`safeAreaPadding`; relative sheet detents use the full window height). With `bar` (also the older-device
fallback) a translucent host row stays above clipped authored content, independent of spec style and
opacity, and its height is excluded from the authored viewport. Both fullscreen modes keep window alpha at 1
and fade only authored content and its scrim.

The dismiss bar's button and the persistent (`persistence: "device"`) sheet and floating Close control are one
circular close chip (#15119), the twin of the iOS chip: a 32 dp opaque `prototypeCloseColors` fill with a
Close glyph, no text label, a 48 dp hit target, and the shared host id `automobile-prototype-dismiss`
(`testTag`, exposed as the resource id) with content description `Dismiss AutoMobile prototype`. The persistent
chip sits top-end inside the system-bar and cutout insets; the bar keeps its inset-aware row. The brief
chromeless escape pill keeps its text and carries the same id (#15120). The `automobile-` `testTag` prefix is
reserved on every platform (the validators reject an authored tag with it), observe sees the controls by that id,
and `tapOn` moves its point off them or fails naming the control that covers the whole target. Session-scoped sheets and floating windows still draw no host control
(they end through the agent's `dismiss`, a replacing show, the TTL or a disconnect).

A `persistence: "device"` prototype outlives its host session: it is not dismissed when the last client
disconnects (including a show queued after that edge), has no idle TTL, and keeps its assets until
dismissal. Because nobody may be connected to remove it, sheet and floating windows carry an opaque "Close"
control above the authored content, and opacity fades only the content. Fullscreen defaults to `bar`; a
device with `prototype_window_chrome_v1` also honours explicit `none` with the hidden escape. It ends
through that control, the dismiss row or pill (`user`), `dismiss_prototype` (`agent`), a replacing show, or
service unbind/destroy (`teardown`). Keyguard hiding is unchanged.

Events a persisted prototype emits while no client is connected (checked per event
against the live client count) go to a bounded ring in `PrototypeController`
(`PrototypeOfflineEventBuffer`, 200 events, oldest dropped and counted). The ring
is flushed under the controller mutex, so order is preserved: when a client
connects (`onClientConnected`), before the next live event, and before an
`inspect_prototypes` reply. Session-scoped prototypes never use it. `inspect_prototypes`
returns one `prototype_result` with `prototypes` (`id`, `persistent`, `state`,
`pages`, `lastSequence`) and `droppedEvents`, the cumulative count dropped from
the ring. The host adopts the report into its status store and event buffers,
because the host clears both on session release. Both behaviours are advertised
as `prototype_persistence_replay_v1`; a host refuses `inspect` without it.

Every dismissal emits one `prototype_event` with `kind: "dismissed"`, null `name` and
`payload: {"reason": "user|agent|disconnect|ttl|teardown"}`. Host and authored dismiss controls use `user`;
`dismiss_prototype` `agent`; last-client disconnect `disconnect`; idle expiry `ttl`; service teardown,
unbind/restart and owning-display removal `teardown`. Sequence allocation precedes delivery even with no
socket. A show replacement closes the old runtime silently and cancels its timer. Disconnect counts are
captured at removal with the existing observer-session generation so rapid reconnects cannot erase the zero
edge or dismiss a replacement. No state persists across process restart.

Idle means no interaction or accepted show. The device fallback TTL is five minutes (300,000 ms), settable
locally on the controller. Shows (including same-id) and user interactions restart it (initial or restored
unchanged pager reports do not); configuration changes and safety hide/restore do not, and hidden
prototypes still expire. The strict protocol has no TTL or session-release message, so session release is
covered only when it closes the last WebSocket.

Rotation, density/size changes and fold posture callbacks refresh layout params
without recreating runtime or composition: authored state and settled pager pages
survive with no event or sequence allocation. If the owning display disappears,
dismiss rather than moving content onto another display; it never revives on return.
V1 uses the service's default display; display selection remains #9308.

Show-time keyguard/screen checks fail closed. Screen and window signals hide the
window while locked or noninteractive and restore the same runtime on unlock;
no dismissal event is emitted for temporary hiding. Own-package accessibility
events are dropped before hierarchy debouncing and navigation tracking.

### Foreground scoping (#10261, owner decision 2026-10-09)

A session prototype is tied to the app (package) it was shown over, matching the iOS agent, which lives inside the app. When that app leaves the foreground the window is hidden (state, pages and the idle TTL are kept; no `dismissed` event, no sequence allocation) and when the app returns the same runtime is shown again. A `window.persistence: "device"` prototype is a standalone mock and is not tied to an app.

- **Anchor.** Each `show` (including an in-place replace) reads the application window in front (the active application-type accessibility window, else the topmost) and clears any suspension. If none qualifies the prototype is unscoped and stays up everywhere.
- **Signal.** `TYPE_WINDOW_STATE_CHANGED` events already delivered to CtrlProxy; no new poller. An event moves the foreground only when its window is `TYPE_APPLICATION` and its package is not CtrlProxy's own and not in the ignore set, so IME, system dialogs, this prototype's own overlays and the shade are never candidates. Ignore set: `com.android.systemui`, `com.google.android.permissioncontroller`, `com.android.permissioncontroller`, `com.google.android.packageinstaller`, `com.android.packageinstaller`, `android` (resolver, ANR and crash dialogs). A dialog of the same app is the same package. An event whose window type cannot be read is ignored (fails open: nothing hides).
- **Debounce.** A flip either way applies only after the new state holds 400 ms (`PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS`).
- **Hidden means gone.** The window is removed: no touches, absent from `observe`. `inspect` reports `suspended: true` on the entry and the hierarchy capture carries top-level `prototypeSuspended: true`, so `layer: "prototype"` calls fail with "hidden because the app it was shown over is not in front" rather than "no prototype is showing". `inspect` also reports optional `hiddenReason`: `app_layer_window_hidden` when the app in front hides an app-layer window, or `device_blocked` when locked or screen off; the host carries it into status and `prototype_hidden` layer refusals. A show reports `visible: false` with the same `notVisibleReason`; older devices retain `no_prototype_window_on_screen`. Hidden reasons are absent when visible or suspended.
- **Host side.** The host stores `suspended` from `inspect` and surfaces it on `prototype` status entries (as fresh as the last `inspect`; a new `show` or an `inspect` after the app returns clears it); an `awaitEvent` that times out on a suspended prototype carries the same explanation as a `warning`. Absent on iOS.
- **Separate from other hides.** Suspension is its own state (`PrototypeForegroundTracker.suspended`). The host's `isBlocked` is the lock-screen check OR suspension, so any restore path that calls `show` while suspended is refused, and ending suspension does not undo a capture hide held by another component.
- Dismissal, TTL expiry and teardown release the anchor; a hidden prototype still expires on its idle TTL.

Deferred: secure-window detection has no trusted existing signal.

### Bottom sheet and the keyboard (#10262)

Owner decision 2026-10-09: a bottom sheet moves above the keyboard whenever it is shown and returns to the screen edge when it hides.

- **Scope.** Only a `sheet` window with `edge: "bottom"`; fullscreen, floating, dialog, top and side sheets never move. A `bottomSheet` node rides with its window and needs no handling.
- **Source.** The input-method window's bounds from the accessibility window list (`TYPE_INPUT_METHOD`), not the prototype window's `WindowInsets.Type.ime()`: prototype windows are `TYPE_ACCESSIBILITY_OVERLAY` and not the IME target, and the platform dispatches the IME inset only to the target, so a sheet over another app's field would read 0. Lift is `screenBottom - ime.top` (0 when no input-method window has bounds). Unit-tested with fake bounds; the API 30/34/36 device check is still open.
- **Mechanism.** The host relayouts on the `TYPE_WINDOWS_CHANGED` events it already receives, setting the bottom-gravity window's `y` to the lift. Moving the window moves its touch region; touch-through and the foreground-suspension and capture hides act on the same params and `isBlocked`.
- **No system panning.** A bottom sheet sets `SOFT_INPUT_ADJUST_NOTHING`, so the platform does not also resize or pan it.
- **Motion.** The position jumps: the accessibility source reports no per-frame values (`WindowInsetsAnimation` only reaches the IME target), so `motion: "none"` has nothing to disable.
- **Explicit padding.** `safeAreaPadding` with `ime` still applies inside the window; on a lifted sheet it reads 0 for a non-IME-target window, so it does not double-count.

Device checks must cover keyguard timing, daemon death, pager page 3 across rotation, fold/display removal, and API 30/34/36 keyboard/cutout geometry.

Android only. The iOS agent does not lift a sheet above the keyboard; whether to rely on UIKit keyboard avoidance or match this is an open decision (see [iOS prototype agent](../ios/prototype-agent.md#open-decisions)).

## Placeholder lint (#15444)

A successful `show` or `patch` returns `placeholderFindings` when a repeat or state placeholder sits
in a field that does not bind it, so it would be drawn literally. It is advisory, host-only and
never refuses a show. Each finding names the field `path` (for example `root.children[0].label`),
the `placeholder` as authored and a `detail`. The output keeps 50 findings, and
`placeholderFindingsTotal` reports the full count when it is capped.

- A repeat placeholder (`{index}`, or `{alias.field}` for an enclosing `repeat.as`) in a text field
  that is not in the bindable set, such as `chip.label` or `badge.text`. Fields that bind
  (`button.label`, `topAppBar.title`, `searchBar.placeholder`, and `text` nodes) are not reported.
- A `{key}` state placeholder naming a declared `state` key in `chip.label`, `badge.text`,
  `textField.placeholder` or `searchBar.placeholder`. Only a `text` node reads `{key}` from state.
  Other fields are left alone because a renderer may bind them beyond the contract.

Whether to widen binding to these fields is a separate contract decision (#15444); until then use a
`text` node next to the field.

## Accessibility lint (#14126)

A successful `show` or `patch` returns `accessibilityFindings`: an advisory, host-only lint of the
component-expanded spec sent to the device. It never refuses a show and needs no device capability.
Each finding names a `rule`, the node `path` and a `detail`. The output keeps 50 findings, and
`accessibilityFindingsTotal` reports the full count when it is capped.

| Rule                              | Finds                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlabeled-control`               | A node with `onTap`, `onLongPress` or `onDoubleTap`, or an `iconButton`, `fab`, `switch`, `checkbox`, `slider` or `select`, with no `contentDescription`, `label`, `text`, `spans`, `headline` or `title` on itself or a descendant.                                                                                                                                  |
| `unlabeled-image`                 | An `image` or `icon` with a `testTag` but no `contentDescription`. An untagged, non-tappable one without a description is decorative: the renderers hide it from accessibility, so it is not reported.                                                                                                                                                                |
| `unlabeled-text-field`            | A `textField` or `searchBar` with no `label`, `placeholder` or `contentDescription`.                                                                                                                                                                                                                                                                                  |
| `low-contrast`                    | A `text` node with an authored `style.color` below WCAG AA against the nearest background the host can resolve: 4.5:1, or 3:1 for large text (`textSize` 24 or more, 18.66 or more at `fontWeight` 700, or a `display`/`headline` `textStyle`). It is checked in light and dark, or only the mode `theme.mode` pins; `mode` names the failing one, `value` the ratio. |
| `small-touch-target`              | A tappable node or control whose authored `width`, `height`, `maxWidth` or `maxHeight` is under 48dp (44pt on iOS); `value` is the smallest side. Sizes left to layout are not checked.                                                                                                                                                                               |
| `transition-without-visible-when` | A non-stack node with a `transition` but no `visibleWhen`: nothing ever enters or exits, so the transition never runs.                                                                                                                                                                                                                                                |

Colours resolve on the host as the renderers do: a hex value, a `{light, dark}` pair, or a role
from the Material 3 baseline scheme with `theme.colors` overrides (flat, then per mode). A
`theme.colors.seed` or `source: device` makes the device derive its own scheme, so only the roles
the spec overrides are known then, and text using any other role is not checked. The background
starts at the `surface` role and follows authored `style.background` values, compositing
translucent ones. Under a `gradient`, a `style.alpha`, or a component that paints its own surface
(`card`, `dialog`, `bottomSheet`, `snackbar`, `topAppBar`, `bottomNav`, `tabBar`, `button`, `fab`,
`chip`) the background is unknown and contrast is not checked. `styleWhen` overrides are not
evaluated.

### Pseudo-locale (#14126)

`show` takes `pseudoLocale: true`. The device receives a copy of the spec in which every `text`,
`label`, `placeholder`, `headline`, `title`, `supporting`, `supportingText`, `trailingText`, check `message` and span `text` is
accented, padded by about 40% and wrapped in `[ ]`, so truncation and clipping are visible without a
translation. `{key}`, `{data:/pointer}` and `{item.field}` bindings are left intact, as are
`contentDescription`, state, data, request bodies, `emit` context and payload, `repeat` and option `value`s. The authored
spec is what status, `patch` and the accessibility lint see, so `patch` ops (other than a
`replaceNode`) edit the device copy and a `replaceNode` sends authored text. A `linkify` text keeps its mention, hashtag and URL tokens as written and takes no `[ ]`
wrapper, so links stay detectable. Stack screen and component names are never treated as spec
fields. Each show states the
option afresh.

Every starter template passes this lint with zero findings, pinned by the template gallery test. The
on-device audit of a shown prototype and the RTL check that #14126 also proposes are not
implemented yet.

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

The committed `doc-example-3` fixture is this example verbatim. The renderer refuses an unresolved
element anchor, so the screenshot gallery substitutes a fixed resolved `bounds` anchor (same
alignment) before rendering; only the host resolves selectors.

## Shared verification and sibling updates

The TypeScript and Kotlin suites enumerate the same `test/fixtures/prototype-spec/valid` and `invalid`
files, assert nonempty directories and require coverage of every node, action and placement. Invalid files
wrap `{spec, expectedPath}`. The byte limit has no fixture: each suite generates its own input and checks
the exact byte boundary (whitespace included) and the emit payload boundary. Fixture and contract files are
pinned to LF for Windows; no binary assets are included. The worked examples above are committed as
`doc-example-N.json` fixtures and `test/parity/prototypeSpec.test.ts` asserts they match this page. The page
is registered under How it Works in `mkdocs.yml` and linked from the design index.

## Flow and grid contract (not device-verified)

`prototype_flow_grid_v1` gates `flow` (wrapping row) and `grid`. Both support
children and repeat, with normal node/depth budgets. Flow's optional integer
`maxLines >= 1` clips overflow visually without removing hierarchy children.
`style.spacing` is the item gap; finite nonnegative `style.runSpacing` is the
line/row gap and has the same bounds as spacing (meaningful only on flow/grid).
Grid requires integer `columns` in 1..12 or `{minWidth: dp}` (finite, > 0).
Spacing applies to both axes unless runSpacing overrides the row gap. Grid is
always non-lazy, preserves every child in the hierarchy, and never scrolls
itself; authors wrap it in `scroll`. Row-major placement starts a new row when
a child's span does not fit. Optional integer `span >= 1` is valid only on a
direct grid child and cannot exceed fixed columns; the renderer clamps spans
to the resolved runtime count. Shared fixtures define host validation behavior.

## Carousel and pager indicator (not device-verified)

`prototype_carousel_v1` gates two additions from #12071. A pager may declare `indicator: "dots"`
(default `none`): page dots drawn over the pager (a centred row at the bottom, or a column at the
end edge for a vertical pager) with the current page filled. The dots are decoration and add no
semantics node.

A `carousel` node is a horizontally scrolling, snapping row with one item per child (at least one;
`repeat` expands like `row`). `itemWidth` (dp, > 0, <= 10000) is required; `variant` is
`multiBrowse` (default), `hero` or `uncontained`; `itemSpacing` is dp >= 0. It has no page index,
event or `setPage` target; use a `pager` when the page matters. The host refuses a show on a
CtrlProxy or iOS agent without the capability before sending it, and the iOS result carries a
`carousel` platform note.

Android maps `multiBrowse`, `hero` and `uncontained` to `HorizontalMultiBrowseCarousel`,
`HorizontalCenteredHeroCarousel` and `HorizontalUncontainedCarousel`; items are clipped with
`maskClip` and only the visible items are composed, so off-screen items are absent from `observe`
until scrolled in. A repeat that expands to no items draws nothing.

## Pull-to-refresh (`scroll.refresh`, not device-verified)

A vertical `scroll` may declare `refresh: {stateKey, onRefresh}` (1-32 actions in `onRefresh`, the
same union as `onTap`). `stateKey` names a boolean state key that shows the refresh indicator
while it is true; it must be boolean if declared, and a horizontal scroll with `refresh` is
rejected at `<path>.refresh`. A pull writes true to the key (emitting a `change` event) and then
runs `onRefresh`; the prototype's own `setState`, or a `patch` of `/state/<key>` with a
`baseRevision`, writes false to end it. A pull while the key is already true is ignored. Repeat
and component placeholders bind in the key and the actions like `onTap`. The capability is
`prototype_refresh_v1`; the host refuses a show on an older CtrlProxy or iOS agent before sending
it.

Android draws it with Material `PullToRefreshBox` around the scroll; the authored `testTag` and
size modifiers sit on the box. iOS uses `refreshable`, whose async closure stays open until the key
is false again; a key set true without a pull (an agent patch) shows a plain `ProgressView` at the
top because SwiftUI cannot start `refreshable` programmatically.

## Chat lists (`prototype_chat_scroll_v1`, #14232, not device-verified)

A vertical `scroll` can be a conversation view:

| Field            | Rule                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reverse`        | Anchors the scroll at the end of its content (Android `verticalScroll(reverseScrolling = true)`), so the newest row is at the bottom and growth keeps the end in view. |
| `stickToEnd`     | A forward scroll at its end follows rows appended to it. A reverse scroll is anchored at its end already.                                                              |
| `atEndKey`       | A declared boolean state key the runtime writes when the end position changes, as a `change` event, for a "new messages" pill.                                         |
| `onStartReached` | 1 to 32 actions run once each time the scroll reaches its start (edge-triggered; a list that fits never fires), for loading older history.                             |

The options need a vertical scroll (`Chat scroll options need a vertical scroll` at the option's
path), and `atEndKey` a declared boolean state key. `scrollTo {scroll, to, animated?}` moves the
scroll whose `id` is `scroll`; exactly one scroll may carry that id (`Unknown scroll id`,
`Duplicate scroll id` at `.scroll`). `to` is `"start"`, `"end"` or `{key: value}`, a `repeat.key`
value of a row inside the scroll; a key that is not laid out drops the request. `animated` defaults
to true. Scrolling is not a state change and emits nothing. A composer is a row with a `textField`
(`imeAction: "send"`, `onSubmit`) and a send `iconButton`, padded with
`safeAreaPadding {edges: ["bottom"], types: ["ime", "systemBars"]}`; whether a fullscreen overlay
receives IME insets is owed device verification, like the bottom-sheet lift (#10262). Rows off
screen are absent from `observe`; `swipeOn lookFor` still finds them. The iOS agent advertises the
capability too (#14671, SwiftUI `ScrollViewReader` with the same edge-trigger rules; the simulator
acceptance of the pill, jump-to-end and keyboard behaviour is still owed).

## Swipe actions (not device-verified)

A `row` or `listItem` may declare `swipeActions: {start?, end?, fullSwipe?}` (needs
`prototype_swipe_actions_v1`). `start` is revealed by swiping right and `end` by swiping left
(mirrored in right-to-left layouts is not done: sides are physical). Each side holds 1-3 entries
`{label, icon?, role?, color?, onTap}`: `label` is the button text and its accessibility name,
`icon` a built-in icon name (an SF Symbol on iOS), `role` `default` (primary colours) or
`destructive` (error colours), `color` a hex or theme role that overrides the background, and
`onTap` 1-32 actions. The first entry of a side sits at the screen edge. A release past 40% of
the revealed width, or a fling past the open velocity, leaves the row open; a drag beyond the
revealed width resists (rubber-band). With `fullSwipe: true` a drag past 60% of the row (or a hard
fling) runs the swiped side's first entry and closes the row. Only one row is open at a time, and a
tap on an open row closes it instead of running its `onTap`. Revealed buttons get the test tag
`<rowTestTag>.swipe.<index>`, counting `start` entries first and then `end`; they exist only while
the row is open. Every entry is also an accessibility action (TalkBack custom action, VoiceOver
action) on the row, so assistive technology can run it without swiping. Reduced motion or spec
`motion: "none"` snaps instead of animating. Put swipeActions on repeated rows; a row inside a
horizontal `pager` or a `carousel` is refused because their drag would compete.

Android drags the row's foreground with `draggable` over the revealed buttons, announces every entry as
a TalkBack custom action and uses the shared swipe thresholds in `PrototypeSwipe.kt`.

## Prototype gesture action lists

`onLongPress` and `onDoubleTap` are optional action lists (1–32 actions, the same union as
`onTap`) on box, row, column, text, image, icon and card only. They require
`prototype_gestures_v1`; the host refuses a show on an older CtrlProxy or iOS agent before sending
it. Each gesture runs its actions like a tap, with no new event kind. Either list makes a node
interactive even without `onTap`. A node with only `onLongPress` and/or `onDoubleTap` does not
consume single taps: the nearest ancestor's `onTap` runs. All three lists may coexist. The
single-tap delay applies only to nodes declaring `onDoubleTap`; `onTap` with only `onLongPress`
fires immediately. Long-press uses the platform default
(about 0.5 s on iOS versus the Android long-press timeout, about 0.4 s).

Each list is also a named TalkBack action (#15123): `onLongPress` is the node's long-click action labelled
`Long press` (on a node with `onTap` too, the labelled `combinedClickable` long click, never a second copy), and
`onDoubleTap` a custom action `Double tap`, since TalkBack's own double tap activates `onTap`. The names are
fixed English defaults. Whether `observe` reports custom actions is unchecked: the extractor maps only known
action ids (`ViewHierarchyExtractor.kt`), so a device capture is owed before the guide promises it.

`tapOn` with `action: "longPress"|"doubleTap"` and `layer: "prototype"` drives them by
coordinate gesture; no new MCP tool is needed. Repeat and component action placeholders bind
as they do for `onTap`.

## Search bar contract (#12069)

`searchBar` requires `stateKey` naming an initialized string query. Optional
`placeholder` follows `textField` rules; optional `leadingIcon` uses the same
catalog as `button.icon`. Optional `trailingActions` has one or two
`{icon, label, onTap?}` items, with a required catalog icon and nonempty accessible
label. `onSubmit` is an optional ordinary action list for the keyboard search action.
Typing reuses the text-field state-write and `change` event path. A visible search
bar is a text target and makes the prototype window focusable for the IME.

Optional `activeKey` names an initialized boolean. While true, the optional single
`child` results subtree is shown. A child without activeKey is invalid; activeKey
without a child is valid. `variant` is `bar` (default, expands to fill its parent
while active) or `docked` (stays in place, results directly under the field).
The child, submit actions and trailing actions participate in ordinary validation,
limits, unique ids, state checks, emit-name collection, template binding, anchors
and text-target walks. Repeat placeholders bind in the placeholder and trailing labels.

Show and patch results containing the node require `prototype_search_bar_v1`;
the host refuses them before any device request if it is absent. This pass adds
the shared contract and host only. The later Compose implementation must use
material3 `SearchBarDefaults.InputField` inside an in-tree `Surface`/`Column`,
pinned to the material3 supplied by `androidx-compose-bom` in
`android/gradle/libs.versions.toml`. Results are ordinary rows inside the prototype
window, not a SearchBar popup/dialog or lazy list that drops rows, so `observe`
sees every result row.

## Loading and empty states (#14207, `prototype_loading_states_v1`, not device-verified)

A data condition may test emptiness instead of comparing: `{data: "/feed", empty: true}` holds
when the value is missing, `[]`, `{}` or `""` (`null` cannot be stored in `/data`), and
`empty: false` holds otherwise. `empty` takes the place of `equals`, `notEquals`, `gt` and `lt`
(exactly one is required), and `{key, empty}` is rejected at `<path>.empty` with
`empty applies only to data conditions`. Like other data conditions it is resolved on the device
against the current `/data`, so a request response or data action flips it.

Style `shimmer: true` draws a highlight band sweeping across a `box`, `row`, `column` or `card`
over its background and inside its clip; any other node type is rejected at
`<path>.style.shimmer`. The node reports state description "Loading". With `motion: "none"` or
animator scale 0 no band is drawn, so screenshots see the plain placeholder. A `repeat` of literal
placeholder rows makes a skeleton list. The iOS agent advertises the capability too (#14689): it
sweeps the same band (1.2 s, 35% white, clipped to the node's corner shape) over the node, reads
"Loading" to VoiceOver with the updates-frequently trait, draws no band under `motion: "none"` or
Reduce Motion, and rejects shimmer on other node types at the same path.

## Effects (#15128, #15129, `prototype_effects_v1`, not device-verified)

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
  Decision on the open question: no new `prototype_event` kind (that closed list is a contract change
  shared with the TS host and iOS), so a frozen effect is visible on the next `inspect`, not pushed.
  ProtoViewer shows no note when it degrades an effect; that stays an open follow-up.
- **Owed device checks.** Goldens on API 30, 33 and 36 (`effects_all_types`, pending in
  `PrototypeSpecContentScreenshotTest`), and a real-GPU look at the AGSL effects. Robolectric covers
  decoding, API planning, the clock and budget on fakes, and bounds stability.

## Charts (#14209, not device-verified)

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

## Rich text

A text node has exactly one of `text` or `spans`; plain `text: ""` remains valid.
Spans are strict `{text, style?, onTap?}` objects with nonempty, untrimmed text; whitespace is valid.
Span style accepts only color, fontWeight, fontStyle, textDecoration, textSize, letterSpacing,
fontFamily and background, with the same ranges as node style; background is a colour, never a gradient.
There are no span ids, testTags, visibility conditions, nested spans or URLs.
Each span uses the same state `{key}`, data `{data:/pointer}`, repeat `{item.field}` / `{index}`
and component `{props.x}` binding as node text; span actions bind like node onTap actions.
The resolved texts concatenate in order without separators: observe and accessibility show the
full plain text (an explicit node contentDescription still overrides its accessible label).
Spans do not count as nodes and require `prototype_rich_text_v1`; older devices are refused before show.
A tappable span is part of the text node, not a separate accessibility node, and runs actions without opening URLs.
On Android, activate it with `tapOn {accessibilityLink:"<span text>"}` or
`tapOn {text:"<full plain text>", subtext:{text:"<span text>"}}` without `layer`:
these selectors act across windows because tapOn refuses layer with accessibilityLink/subtext (#9305).
Use `tapAt` on the span bounds as the fallback.
On iOS, links are drawn as links and tap-through is by `tapAt` only; show reports the
`rich-text-links` platform note for tappable spans because there are no separate accessibility elements or semantic links.

### Linkify (#14233)

`linkify: {kinds, style?, onTap}` on a text node with `text` (not `spans`) turns @mentions,
#hashtags and URLs in the resolved text into links, for content from data such as `{item.body}`.
`kinds` lists 1 to 3 of `mention`, `hashtag` and `url`; `style` takes the span style fields; a tap on
a match runs `onTap` (1 to 32 actions). The grammar is fixed and shared by every runtime
(`test/fixtures/prototype-spec/linkify/cases.json`): a match starts at the start of the text or
after whitespace; a mention is `@` and 1 to 30 of `[A-Za-z0-9_]` (so `ana@example.com` is not one);
a hashtag is `#` and up to 100 letters, marks, digits or `_`, not all digits; a URL is `http://` or
`https://` up to the next whitespace with trailing `.,;:!?'")]}` removed. Inside `onTap` only,
`{match: "text"}` reads the tapped match (`@ana`) and `{match: "kind"}` its kind: as a `setState`
value, a `setData` / `appendData` value or an emit context entry, for example
`setState profileHandle {match: "text"}` then `push profile`. `{match}` anywhere else is refused.
Inside a repeat, `onTap` also binds `{item: "field"}`, `{index: true}`, `{alias.field}` and `{index}`
per row, including state keys such as `liked_{item.id}`. Repeat binding preserves `{match}` for
tap-time resolution; emit payloads and `{value: ...}` literals remain opaque. A URL tap never opens a browser; that is the `links.open`
platform call. Matches are links like tappable spans (Android `tapOn {accessibilityLink}`, iOS
`tapAt`) and require `prototype_linkify_v1`.

Owed device checks (later platform passes): advertise the capability only after renderer support;
verify mixed span styles, resolved concatenated observe text, per-span actions without URL navigation,
Android semanticLinks and both selectors across windows, and iOS tapAt-only links plus platformNotes.
The shared contract caps spans at 64 per text node. Host tests do not verify device rendering.

## Menu and select

`menu` and `select` require `prototype_menus_v1`; the host refuses them before showing or uploading assets when the connected renderer lacks it.

A `menu` requires `openWhen: {key, equals}` with a boolean equality and 1–16 strict `items`. Each item is `{label, icon?, trailingText?, enabled?, onTap?}` or exactly `{type:"divider"}`. Labels and trailing text are nonempty, icons use the existing icon names, and `onTap` has 1–32 existing actions. A disabled item is dimmed, cannot be tapped and does not close the menu. Dividers are neither focusable nor tappable. The elevated surface aligns to its parent’s bottom end. When it cannot fit below and fits above, it opens above the parent; otherwise it keeps its below placement clamped inside the window. Horizontal alignment is unchanged. An enabled item or outside tap writes `!equals` to the open key; item actions run after closing.

While a menu is open, the page behind it is removed from the accessibility tree, like a dialog; the menu items and outside-dismiss layer remain exposed. Closing restores the page. An expanded select leaves the page in the accessibility tree.

A `select` requires a string `stateKey` and 2–32 `{value,label}` options with unique nonempty values and nonempty labels; its optional label is nonempty. It shows the current option’s label, or empty text when no option matches, and a trailing expand indicator. Expansion is local view state. Choosing an option writes the string key, emits the same `change` payload as `radioGroup`, and collapses the list. Tapping the field again or outside also collapses it. Both nodes support repeat templates and reusable `use` components: state keys, menu item labels/trailing text/actions and select labels/option labels bind placeholders.

Rendering stays inside the prototype window on both platforms so `observe` and `tapOn` reach the normal hierarchy. Android uses an in-window surface rather than a separate DropdownMenu/Popup window. iOS uses an in-window list rather than system SwiftUI Menu/Picker popups; successful iOS shows report this substitution in `platformNotes`. Menu icons use the existing SF Symbols mapping on iOS.

The select field and menu surface carry the node `testTag`. Select option rows use `<testTag>.<value>`; menu item rows use `<testTag>.<index>`, with zero-based positions including dividers. Android adds row tags only when `testTag` is set; iOS falls back to `(testTag ?? id).<value>` or `(testTag ?? id).<index>`.

## Tooltip and drawer

`tooltip` requires `prototype_tooltip_v1`, nonblank `text`, boolean `openWhen: {key, equals}`,
and exactly one of `anchorTo` or `anchor`. `anchorTo` names exactly one node id after component
and repeat expansion; self references and absent targets report `Unknown anchorTo id`, and
multiple instances report `Duplicate anchorTo id`, at the tooltip's `.anchorTo` path. Bounds
anchors use the host-resolved screen rectangle plus offset. Tooltips are hoisted overlays, not
ordinary anchored layout children. An unlaid-out target draws no bubble or scrim and keeps state.

The pure `placePrototypeBubble` function places tooltips inside the window with an 8 dp gap and
margin. `caret` names the bubble edge pointing at the target: `top` places it below, `bottom`
above, and `start`/`end` mirror with layout direction. `auto` prefers below. An unavailable side
flips to its opposite; auto can use horizontal space when neither vertical side fits. If neither
side fits, the larger available side wins and the origin is clamped. The caret tracks the target
center, clamped away from the bubble corners. Menu placement shares this calculation.

Optional `spotlight` draws the themed scrim at 40% with an even-odd rounded cutout around the
target: `padding` defaults to 8 dp and `cornerRadius` to 12 dp, both integers from 0 through 64.
The bubble exposes text and the node test tag to accessibility; the scrim uses `<testTag>.close`.
With a spotlight the page semantics are cleared, focus moves to the bubble and returns to the
`anchorTo` target on dismissal. Without a spotlight the page stays interactive and exposed.
Scrim taps and bubble taps without `onTap` write `!equals`, then run optional `onDismiss` actions.
A bubble with `onTap` runs only those actions, allowing state-driven tours.

`drawer` requires `prototype_drawer_v1`, `edge: start|end`, boolean `openWhen`, and one `child`.
The logical edge mirrors in RTL. Its surface fills the safe-area height and is
`min(320dp, window width - 56dp)` wide. Optional `scrim` uses the themed color-value rules;
omission uses the scrim role at 40%. The scrim's `<testTag>.close` tap writes `!equals`.
`dismissOnSwipe` defaults to true: dragging toward the panel's edge beyond half its width
uses the bottom-sheet settle rule to dismiss. Opening is state-driven only.

Drawers clear the page's accessibility semantics, move focus into the panel, restore the page's
previous focus on close, and take Back/Escape before stack navigation or window dismissal.
The last open panel remains composed through exit, including removal from the author tree.
Panel motion is a 300 ms edge slide with a fading scrim; `motion: none` or animator scale zero
settles instantly. `LocalPrototypeReducedMotion` replaces the slide with a cross-fade. Drawer
transitions report through `ReportPrototypeMotion` until settled; the renderer does not supply
the reduced-motion preference itself.

## Checks

`textField.errorWhen` controls presentation only; validity and emitted validation results remain checks-only.

Devices advertising `prototype_checks_v1` evaluate declarative checks locally. The host refuses
show and patch results using this feature on older devices. Inputs `textField`, `slider`,
`checkbox`, `switch`, `radioGroup`, `datePicker` and `timePicker` accept `checks` (1–8 entries)
and `validateOn: "change" | "blur" | "submit"` (omitted means blur). Each check contains a
nonempty `message` and exactly one rule. `validateOn` controls error display, never validity.
The first failing message is displayed.

- `required: true`: trimmed nonempty text, true for checkbox/switch, nonempty selection for
  radioGroup/datePicker, present number for slider/timePicker.
- `minLength` / `maxLength`: nonnegative integer UTF-16 lengths, textField only.
- `min` / `max`: finite numeric inclusive bounds, slider and pickers only. Text fields hold
  strings and have no numeric subtype. Date state remains YYYY-MM-DD; bounds are UTC epoch
  milliseconds. Time pickers retain hourKey/minuteKey; checks apply independently to both keys.
- `format`: textField only, one of email, phone, digits, decimal, url.
- `pattern`: textField only, the restricted grammar below, at most 128 UTF-16 units.

Empty string, null or missing value passes all rules except required. Whitespace is only empty
for required. Pattern and format matching use at most 4096 UTF-16 units. Required and length checks inspect the complete value.
Every validity reference must name declared state with at least one check. Multiple checked
controls sharing a key must all pass. Numeric/length lower bounds must not exceed upper bounds.

Formats use these exact whole-value expressions (ASCII digits):

- email: `[^\s@]+@[^\s@]+\.[^\s@]+` (Unicode names allowed).
- phone: optional leading +, then 7–15 characters from ASCII digits, space, hyphen and parentheses;
  at least seven digits. The leading + is outside the character count. Punctuation need not balance.
- digits: `[0-9]+`.
- decimal: `-?[0-9]+(\.[0-9]+)?` (no exponent or leading +).
- url: `https?://[^\s/?#]+([/?#]\S*)?` (lowercase scheme, Unicode hosts allowed).

Format whitespace follows JavaScript whitespace (including NBSP); no format trims its value.
Patterns use ASCII `\d`, `\w`, `\s` and their complements `\D`, `\W`, `\S`; `\w` is
`[A-Za-z0-9_]` and `\s` is space, tab, CR, LF, FF, VT. Dot matches one Unicode scalar except
CR, LF, U+2028 and U+2029. Matching consumes the entire value, even with a final newline.
Allowed: literals, dot, classes `[abc]` / `[^abc]`, literal ranges, those six shorthand escapes,
escaped metacharacters, anchors ^ $, groups `(…)` / `(?:…)`, alternation |, and quantifiers
`? * + {n} {n,} {n,m}`. Every written bound is <=100 and n<=m; open upper bounds are unbounded.
Reject backreferences, lookahead/behind, named groups, lazy/possessive quantifiers, Unicode
properties, inline flags, word boundaries `\b` / `\B`, and every other escape (including
`\n`, `\x`, `\u`; use literal characters). Empty classes are rejected. A group repeated more
than once cannot contain alternation or any variable quantifier (maximum > minimum), transitively.
At most two variable quantifiers are allowed in the entire pattern: ? * + {n,} and {n,m} when
m>n. Fixed {n} quantifiers inside repeated groups remain allowed.
Thus `(a|b)+`, `(a+)+`, `(a*)*` and `((ab)+)+` are rejected. Optional groups remain allowed.
These exact rules and error substrings are pinned in the language-neutral checks fixtures.

Conditions `{valid: "email"}` and `{valid: ["email", "password"]}` mean all referenced keys
are valid, including fields whose errors are not yet shown. They compose with all/any/not in
visibleWhen, styleWhen and enabledWhen. enabledWhen is supported on the seven input types plus
button, iconButton, fab, chip and listItem; false disables the control and skips its onTap.
`emit` may specify `requireValid: ["email", "password"]` (1–8 keys). Any failing key aborts the
whole action list atomically, shows errors on every listed field, and sends
`{kind:"validation_failed", keys:[…]}` naming only the failing keys. `change` events carry
`validity: {key:boolean}` for checked keys. Both event kinds retain the usual event envelope.

## Saved prototype activity

`SavedPrototypeLaunch.intent(context, id)` targets the explicit
`SavedPrototypeActivity` component with data `automobile-saved-prototype:/<id>`
(the single path segment is encoded with `Uri.Builder`) and
`FLAG_ACTIVITY_NEW_DOCUMENT`. No extras are read: intents select only an id,
never a spec or assets. `documentLaunchMode="intoExisting"` matches component and
data via `Intent.filterEquals`, giving each id its own task while reusing the
same id's task. Shortcut publishing may add flags; shortcut removal is limited to
`disableShortcuts` (see "Saved prototypes on the Android home screen").

A document relaunch calls `onNewIntent`, updates the activity's intent and reloads
the saved entry. It closes the previous runtime without emitting a dismissal,
then renders the latest snapshot or the corresponding typed error screen if the
entry was deleted or cannot be opened. A different id delivered to the activity
also reloads. Handled configuration changes preserve the live runtime state.

The activity is `exported=false` with no intent filter: app-owned launches (including our pinned shortcut intents) can open it, other apps cannot render saved content or probe ids. Rejected: exporting with a signature permission (an unnecessary external entry point) and exporting with an intent filter alone (any app could enumerate and launch saved entries). Explicit app-owned intents also avoid Android 15's stricter intent matching.

Saved entries live under `savedPrototypeRoot(context)`, the credential-encrypted
app-private `filesDir/saved-prototypes` directory. Locked storage is checked
before constructing or calling the store. Missing ids, deleted entries, corrupt
content, unsupported format versions and locked storage have typed screens;
raw storage messages and paths never reach the UI.
The Locked screen is defensive: the app is not `directBootAware`, so this
activity cannot start before the device's first unlock. The storage check also
covers unavailable credential storage, such as a locked work profile.

The existing runtime and Compose renderer run in an activity window without
accessibility service state, overlay ownership, idle timeout, disconnect
dismissal or foreground-app scoping. Back, authored dismiss and HostDismiss
finish the activity and emit exactly one `dismissed` event with reason `user`.
A system process kill emits nothing. Offline events enter the process-level
`SavedPrototypeEvents.buffer`; a registered delivery consumes an event only when
it returns true. Sequence numbers are allocated per prototype id for the process
lifetime and continue across activity recreation and document relaunch. Future
replay must synchronize on the buffer while draining or
restoring it. The bounded buffer is in memory and does not survive process death.

### Multiple surfaces (phase 1)

On Android, `show` with `replaceOthers: false` adds another prototype window, requiring
`prototype_multi_surface_v1`. Up to four distinct ids can be shown; a fifth is refused with the
ids already shown, leaving them unchanged. Showing an existing id with `replaceOthers: false`
replaces only that prototype. Omitted or `true` replaces the other prototypes.
`dismiss {id}` removes only that id; `dismiss {all: true}` removes all. `status` lists every
shown prototype by id, and `inspect` reconciles the full device list. State, patches and
`awaitEvent {id}` remain independent per prototype.

Not yet supported in this phase: `stateGroup` / shared state groups, `window.z`, selective
observe exclusion, cross-window focus, iOS multi-window parity, or `prototype_state_groups_v1`.

## Saved prototypes on the Android home screen

`prototype` `save` (needs `prototype_saved_v1`) stores the validated spec and its assets in
CtrlProxy's app-private storage. With `pin:true` the host then sends `pin_saved_prototype`, and
CtrlProxy calls `ShortcutManager.requestPinShortcut` with the stored label and an adaptive icon
(uploaded `icon` asset, else the label's first letter). The shortcut's intent selects only the
prototype id; tapping it opens `SavedPrototypeActivity`, which needs no host.

- Android never pins silently: the default launcher always shows its confirmation dialog, so a
  fresh pin is reported `pending`. Declining delivers no callback. `autoConfirm` taps the dialog's accept
  button by label and reports `pinned` only after `listSaved` confirms (#12266, device-verification
  work: launcher dialogs differ).
- A launcher caches its workspace, so a new or updated shortcut can stay invisible (#14887). After a
  `pinned` result, or a save whose shortcut was `updated`, the host looks for the label on the home
  screen. If it is missing, it resolves the default launcher (`cmd package resolve-activity`), and
  when that package is a known launcher runs `am force-stop` plus a HOME intent once, waits for the
  launcher's tree to go quiet, and looks again. The result reports `launcherRestarted` and
  `shortcutVisible`; an unknown launcher is left alone with a warning. It is on by default on
  emulators and physical devices; `restartLauncher:false` opts out. It never runs on a pending pin
  (no shortcut exists yet) and runs at most once per call.
- An unsupported launcher keeps the save and reports `pinned:"unsupported"`. A locked or
  screen-off device reports `device_locked`; the save remains and a retry is safe.
- The app cannot remove a pinned icon: `deleteSaved` disables the shortcut. `removeIcon:true`
  runs `cmd shortcut clear-shortcuts` from the host, but only when no saved prototype remains,
  because the command clears all CtrlProxy shortcuts.
- Uninstalling or clearing CtrlProxy deletes saved prototypes and every pinned shortcut; the host
  mirror (#12268) restores the saved content, never the icons.
- Pinning from the accessibility service while no CtrlProxy activity is visible, launcher dialog
  shapes, badges and `clear-shortcuts` behaviour on the workspace are unverified on a device
  (#12261).

## Lazy lists (`prototype_lazy_list_v1`, #14182, not device-verified)

A `list` is its own scrolling container. Its row template is composed lazily in data order;
only composed rows appear in `observe`. Use `swipeOn` on the list to reach later rows. The
container preserves authored `testTag` / `contentDescription` and exposes a scrollable collection
to accessibility (Android LazyColumn/LazyRow collection info and scroll actions; iOS ScrollView).
The list node, `request.append` and `prependData` require `prototype_lazy_list_v1` together with
`prototype_data_model_v1`.

| Field                          | Contract                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repeat`                       | Required `{items:{path}, as, key}`; path resolves relative to `data` to an array of objects. Literal items are forbidden.                                                                                |
| `children`                     | Exactly one row template; `{index}`, `{<as>.<field>}`, state/data bindings and ordinary repeat projection rules apply.                                                                                   |
| `axis`                         | `vertical` (default) or `horizontal`.                                                                                                                                                                    |
| `header`, `footer`             | Optional single ordinary nodes inside the scrolling content, outside the row repeat scope.                                                                                                               |
| `spacing`, `contentPadding`    | Nonnegative dp; gap between rows/header/footer and padding inside the scroll bounds.                                                                                                                     |
| `onEndReached`, `endThreshold` | Ordinary action list; threshold 1–50 (default 3), permitted only with `onEndReached`.                                                                                                                    |
| `refresh`                      | `{stateKey,onRefresh}` as on scroll: declared boolean state key, set true before actions run. Vertical lists only; also needs `prototype_refresh_v1`.                                                    |
| `maxItems`                     | Optional integer 1–`MAX_PROTOTYPE_LIST_ITEMS`, greater than `endThreshold` (default 3) when `onEndReached` is set. Initial data must fit. Appends trim the oldest rows from the start in the same write. |

`repeat.key` must name a projected scalar field present in every item, with unique rendered
values. Keys preserve row identity across appends, trims and reorders. Empty lists and several
independent lists in one spec are valid. Lists cannot appear inside another list or a repeat
template, including expanded components. A list and an ancestor/descendant scroll cannot share
an axis; cross-axis scrolling is allowed. The row template cannot contain another repeat or pager
(the existing repeat-template restrictions apply).

The row template counts once against node/image limits, even for zero rows; header/footer count
once each. Per-item field, state-key, action, substitution and repeat-path-cell budgets still
apply. List paths accept up to `MAX_PROTOTYPE_LIST_ITEMS` (2000), with overflow reported at
`<list>.repeat.items.path` as `Repeat path resolves to more than 2000 items`. A source longer than
`maxItems` fails there with `List data has more items than maxItems`. Ordinary repeats keep their
128-item cap and count expanded instances.

The edge trigger is per list path and resets on a new show. It fires for a nonempty list when
`lastVisibleIndex >= rowCount - endThreshold`, once per `(rowCount,lastRowKey)` signature.
Recomposition preserves the signature. A page adding no rows does not retrigger; a sliding
`maxItems` window can retrigger at unchanged length when its final key changes. A list fitting
on screen fires once and again as new pages arrive to fill the viewport. It runs ordinary actions
without an extra interaction event. Header/footer do not contribute to row counts.

`request.append:{from,to}` reads an array at the RFC 6901 `from` pointer in the JSON response,
removes that object member from the remaining response, and extends the existing array at the
`/data/...` target `to`. `from` must have an object parent, not an array parent. Optional `into`
receives the remaining response and must not overlap `to` in either direction. A literal `to`
that already resolves to a non-array is invalid; whole `{index}` segments follow `into` rules
inside repeats. Response validation, extend, `into` and metadata writes are atomic: a missing or
non-array source/target, unsupported parent or data-limit failure rolls everything back and
reports `invalid_response`. The result reports `appended`, the number of response rows added.

`appendData`, `prependData` and request append use the smallest `maxItems` among lists whose exact data
path matches the write target. The shared writer supports `append` (one value), `extend` (array values) and `prepend` (array values), with optional `maxItems`; append/extend trim from the start and prepend trims from the end before checking final
array/byte/depth limits, and reports `trimmed` (0 when none). Without a cap, the ordinary
`MAX_PROTOTYPE_DATA_ARRAY_ITEMS` limit applies after concatenation. `extend` rejects a non-array value with
`invalid_value`, a missing target with `not_found`, and a non-array target with `not_array`.

A device change event names the target `/data/...` path and carries
`{op:"append"|"extend"|"prepend",value,maxItems?,revision}`. The host replays it through the same writer;
malformed extend/prepend values or noninteger/nonpositive `maxItems` are dropped. A page too large for the
emit byte budget travels without `value`; the host then stops tracking the spec instead of mirroring
it. Request success emits the extend event first, then `into`, `into__meta`, status key,
`prototype_request` and `onSuccess`.

`prependData {path,value}` resolves one binding value `v` and writes `{op:"prepend",path,value:[v],maxItems?}`.
The writer preserves page order (`value ++ existing`) and keeps the first `maxItems` rows, even
when the page alone exceeds the cap. Empty pages still trim existing rows. Its errors parallel
`extend`, with messages naming `prependData`; trimming precedes final limits. It requires
`prototype_lazy_list_v1`, `prototype_data_actions_v1` and `prototype_data_model_v1`.

Renderers retain the first visible row's key and on-screen offset across row changes, including
at the top; headers and footers are not anchors. Prepended rows stay above the viewport until the
user scrolls up. If the key was trimmed, the renderer default applies. Each stack entry retains
its list anchor (row key and offset) while covered by a push and restores it on pop; a missing row
falls back to the nearest surviving index or top.

A newer request cancels an in-flight one whose `into` or `append.to` equals, contains or sits inside
the newer request's `into` or `append.to` (latest wins), so a refresh that replaces `/data/feed` and
a page append to `/data/feed/items` cannot interleave. A failed page request does not re-arm the
trigger; the signature changes again only when the data does (a refresh, for example). A device data
write that would leave a list's array with a non-object row, a missing, non-scalar or duplicate
`repeat.key`, or more than `maxItems` rows is refused (`invalid_value`) and changes nothing.

```json
{
  "id": "feed",
  "window": {
    "placement": {
      "type": "fullscreen"
    }
  },
  "data": {
    "feed": {
      "items": [
        {
          "id": 1,
          "title": "One"
        },
        {
          "id": 2,
          "title": "Two"
        }
      ]
    },
    "page": {
      "next": "p2"
    }
  },
  "state": {
    "refreshing": false,
    "feedStatus": "idle"
  },
  "root": {
    "type": "list",
    "repeat": {
      "items": {
        "path": "/feed/items"
      },
      "as": "post",
      "key": "id"
    },
    "children": [
      {
        "type": "text",
        "text": "{index}: {post.title}"
      }
    ],
    "id": "feed-list",
    "header": {
      "type": "text",
      "text": "Feed"
    },
    "footer": {
      "type": "text",
      "text": "End"
    },
    "spacing": 8,
    "contentPadding": 12,
    "endThreshold": 2,
    "maxItems": 100,
    "onEndReached": [
      {
        "type": "request",
        "url": "http://localhost:8080/feed?after={data:/page/next}",
        "into": "/data/page",
        "append": {
          "from": "/items",
          "to": "/data/feed/items"
        },
        "statusKey": "feedStatus"
      }
    ],
    "refresh": {
      "stateKey": "refreshing",
      "onRefresh": [
        {
          "type": "request",
          "url": "http://localhost:8080/feed",
          "into": "/data/feed",
          "onSuccess": [
            {
              "type": "setState",
              "key": "refreshing",
              "value": false
            }
          ]
        }
      ]
    }
  }
}
```

Prepend, anchoring and per-stack-entry list scroll restore are not device-verified until the acceptance run; benchmark qualification remains unverified.

### Timers

`onAppear` requires `prototype_timers_v1`: 1..32 ordinary actions on the root or a node
with `visibleWhen`, rejected at `<path>.onAppear` elsewhere. First show and reset show run
initially visible handlers; later hidden-to-visible edges run them again. A state-preserving
same-id show seeds visibility without firing, and visible-to-visible updates do nothing.
Effective visibility includes ancestors and the active pager/stack child. Repeat instances bind
handlers like taps and keep separate path identities. Each handler is one validated atomic
interaction with tap change-event rules and no idle-TTL activity. Cascades stop at the action-depth
limit; a handler cannot run twice within an interaction. Node hiding does not cancel its timers.

`startTimer {id, afterMs, everyMs?, maxRuns?, actions}` and `cancelTimer {id}` require
`prototype_timers_v1`. IDs are literal strings of 1..64 characters and never repeat-bound.
Delays are integers 100..3600000 ms; maxRuns is 1..10000 total fires including the first and
requires everyMs. A list contains 1..32 actions and shares the request follow-up depth limit.
The whole spec, including components and platform handlers, may declare eight distinct timer ids.

Each prototype has a ledger of at most eight live timers. Starting a live id replaces it and resets
runs. Cancelling an unknown id is a no-op. Each fire uses the same atomic interaction as a tap:
requireValid and all planned writes are validated together; rejection drops state changes and events
but counts the run. One change event follows a net state change. Dismiss cancels every timer.
A timer may cancel itself; replacing its own id during a fire wins over the old timer's reschedule.
Repeats advance from the planned fire time, without drift, until maxRuns or cancellation.
Fires never restart idle TTL. Hidden/inactive prototypes freeze remaining time and restore it on
resume; transient screenshot hides do not pause. Dismiss (including TTL, disconnect or teardown)
and replacing show cancel timers; patch preserves them.

The injected clock/scheduler drives real scheduling. `prototype {action:"simulate",id,advanceTimeMs}`
advances 1..3600000 ms without waiting and returns optional `fired`, refusing before sending unless
the capability is advertised. `advance_prototype_clock {id,advanceTimeMs}` fires due timers in
chronological order, ties by start order, including newly started timers due in the window.
Paused advancement fires zero times. Exactly 10000 due fires succeed; if an additional fire is
still due, advancement stops at the last fire with an error and fired=10000, retaining pending timers
for the next call. Real scheduling continues from shifted time. Inspect reports `timers:[{id,nextFireInMs,runs}]` sorted by remaining
time then start order, with nonnegative remaining time frozen while paused. Devices omit the field
when empty; the host returns an array for capable devices, including an empty array when absent,
and omits malformed timer reports.

Cross-field errors point to `.maxRuns` when everyMs is absent and to `.id` on the ninth distinct
startTimer in contract document order. A cancelTimer id with no declaration produces a host-only
show/patch warning. This asymmetry is deliberate: Kotlin and Swift accept it without a diagnostic
and cancellation remains a runtime no-op.

## Strings and semantics (#14210)

`prototype_strings_v1` gates top-level `strings` and every `{t:` display placeholder;
`prototype_semantics_v1` gates every node's `semantics`. Unsupported fields refuse show/patch
before rendering. Host validation and the shared contract define the accepted shape.

```json
{
  "strings": {
    "default": { "cart.title": "Cart", "cart.items": { "one": "{#} item", "other": "{#} items" } },
    "fr": {
      "cart.title": "Panier",
      "cart.items": { "one": "{#} article", "other": "{#} articles" }
    }
  },
  "root": { "type": "text", "text": "{t:cart.title}", "semantics": { "heading": true } }
}
```

The fragment shows the strings/root portion of an envelope. `default` is mandatory. Up to 16 tables,
512 keys per table and 2048 characters per nonempty string/form are accepted. Locale tags match
`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$`; keys match `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`.
Normalized duplicate tags are rejected. Plurals accept only zero/one/two/few/many/other, with other
required. Values may contain `{key}` state bindings and plural `{#}`, but cannot contain `{t:`,
`{data:` or `{platform:`. String tables are opaque to all other binding and node walkers.

Display fields (including spans and semantics.label/hint) accept `{t:key}` and `{t:key|count}`;
contentDescription instead directs authors to semantics.label. Every reference must exist in default;
plural default entries require a count. Counts are non-negative integer literals of 1–9 digits or
`{data:/pointer}`; state-key counts are unsupported. Missing, negative, fractional or non-number
runtime counts select other. Resolution order is data substitution, translation, then state binding.
Translated text is never scanned again for translations. `{#}` becomes decimal count without grouping.

Show `locale` is optional, show-only, at most 35 characters and uses the locale-tag pattern above.
It is forwarded as a top-level `locale` string in `show_prototype` only for specs with strings.
Each show states it afresh. Otherwise the current device preferred locale list is used; configuration
changes on Android and locale notifications/trait changes on iOS re-resolve live without the host.
Expand each requested tag to its full tag then shorter prefixes (`zh-Hant-TW`, `zh-Hant`, `zh`),
deduplicate, and finally try default. Matching ignores case and treats `_` as `-`. Lookup falls back
per key. The supplying table's language selects the plural category; default uses the first requested
language, or en. Missing selected forms use other; a missing runtime key renders its key text.

| Languages                                                                   | Integer category rule                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ja zh ko vi th id ms lo km my                                               | other                                                                                        |
| en de nl sv da nb no fi it es el hu tr bg ca et eu sw ur; unknown languages | one when n=1, otherwise other                                                                |
| fr pt hi bn fa gu kn am                                                     | one when n=0 or 1, otherwise other                                                           |
| ru uk be                                                                    | one when n%10=1 and n%100!=11; few when n%10=2..4 and n%100 not 12..14; otherwise many       |
| pl                                                                          | one when n=1; few when n%10=2..4 and n%100 not 12..14; otherwise many                        |
| cs sk                                                                       | one when n=1; few when n=2..4; otherwise other                                               |
| ar                                                                          | zero at 0, one at 1, two at 2; few when n%100=3..10; many when n%100=11..99; otherwise other |

Hand-written rules are shared across platforms and cross-checked against Intl.PluralRules fixtures
for 0..120, 1000, 1001, 1002, 1011 and 1012. Romance many for million multiples (fr/pt/es/it) is
intentionally ignored. Non-integers use other. With explicit show locale, platformNotes
`strings.fallback` uses platform all and lists the locale plus up to 20 referenced keys reaching
default (`values`, with `paths` into strings.default and `total` only when capped). Without an
override the host does not know device locales. PseudoLocale accents/pads/brackets every table
value/form, preserving locale tags, keys, plural category names and bindings. Node `{t:...}` remains
intact; semantics.label/hint are display fields, contentDescription remains unchanged.

Every node accepts `semantics` with at least one of heading (boolean), liveRegion (polite/assertive),
group (boolean), nonempty label/hint, or unique traits (1–3 of button/image/selected). Label and
contentDescription on the same node conflict; label/hint accept translation/data/state placeholders.
A liveRegion without text descendants is valid.

| Semantics                    | Android Compose                                                       | iOS SwiftUI                                                                                               |
| ---------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| heading                      | heading()                                                             | isHeader trait                                                                                            |
| liveRegion                   | LiveRegionMode.Polite/Assertive                                       | Accessible-text changes post announcements, excluding initial render; assertive uses high speech priority |
| group                        | isTraversalGroup=true                                                 | accessibilityElement(children: .contain)                                                                  |
| label                        | contentDescription                                                    | accessibilityLabel                                                                                        |
| hint                         | onClickLabel for a tap action, otherwise appended to stateDescription | accessibilityHint                                                                                         |
| button/image/selected traits | Role.Button / Role.Image / selected=true; PrototypeRole retained      | isButton / isImage / isSelected                                                                           |

Semantics-bearing nodes bypass decorative/container skips. Android observe exposes `heading` as
string `"true"` (API 28+) alongside `live-region` strings polite/assertive. The iOS XCUITest snapshot
path exposes no SwiftUI traits; observe cannot verify those semantics today. Advisory lint adds
missing-translation (missing key, shape mismatch or missing required integer plural form),
unknown-translation-key (locale key absent from default), and empty-heading (heading without
text/label). Semantics labels name controls for existing unlabeled rules. Findings retain the existing
cap of 50. Device acceptance has not yet been run. Logical RTL swipe sides are not included.

## Dead taps (`window.deadTaps`, `prototype_dead_tap_v1`)

`window.deadTaps: true` enables `emit` events named `prototype_dead_tap`. The
Android device advertises `prototype_dead_tap_v1`; this window option is a host
preflight capability, not a strict-spec gate.

A root Final-pass observer reports single-pointer down/up gestures left
unconsumed by descendants, with movement below touch slop. Scrolling, pager
drags, multitouch and taps outside the content window do not report. Interactive
controls and dismissing scrims consume their gestures. Gesture-only nodes with
nonempty long-press or double-tap actions explicitly mark their down as handled
without consuming it, preserving ancestor clicks. Passive text, boxes, images
and spacers remain dead areas. A single tap on a gesture-only node counts as
handled, even if its hold or double tap action does not fire.

Payloads contain only `stack`, `screen`, `x` and `y`; coordinates are window-local
dp rounded to one decimal. The deepest stack path supplies its id and top screen;
equal depths choose the lowest stack id lexicographically. Both ids are null
without stacks. The event uses normal sequence allocation, state, pages and
stacks. The payload never includes typed text. Authored emits cannot use the
reserved `prototype_` prefix. Disabling the option or closing the runtime stops
reporting.

## Value formatters (#14227)

Optional `derive` maps up to 32 STATE_KEY names to strict
`{of, format, locale?, timeZone?}` entries. `of` contains exactly one of
`{data: "/pointer"}` (relative to data), `{state: "key"}`, or
`{value: number|string}`. Every text field supporting `{data:/pointer}` also
accepts `{derived:name}`; undeclared names are validation errors, unused entries
are allowed, and malformed braces remain literal. Devices render these tokens in
text node text, contentDescription, rich-text spans, button/FAB labels, topAppBar
title, badge text, dialog title/text, and snackbar text. Other text-kind fields
(request url/headers/body, check messages, select/segmented/menu/searchBar labels)
validate unknown names but display the token literally on devices.

`repeat.derive` maps at most 8 names to the same entry shape with `of` restricted
to `{item: "field"}` or `{value: number|string}`. It projects strings onto each
original row for `{item.createdAtText}` (using the repeat's actual alias).
Names cannot collide with any original item field, including non-scalar data
fields. Derived entries do not read other derived entries. Host validation checks projected
field references without evaluating device-local strings; value-dependent checks
on derived repeat keys and emit names are deferred to the renderer. Missing source fields
are allowed and format as empty strings.

`format` contains exactly one of these keys, each containing a strict object:

| Kind     | Options and defaults                                       | Input                                       |
| -------- | ---------------------------------------------------------- | ------------------------------------------- |
| number   | minFraction?, maxFraction? (integers 0..20), grouping=true | finite number                               |
| compact  | style=short (short or long)                                | finite number                               |
| currency | code required, three uppercase ISO-4217 letters            | finite number                               |
| percent  | minFraction?, maxFraction? (0..20)                         | ratio, so 0.256 is 25.6% with maxFraction=1 |
| date     | style=medium (short, medium, long)                         | epoch milliseconds or ISO string            |
| time     | style=short (short, medium, long)                          | epoch milliseconds or ISO string            |
| relative | style=long (narrow, short, long)                           | epoch milliseconds or ISO string            |

minFraction must not exceed maxFraction when both are supplied. Omitted numeric
fraction options use Intl/CLDR defaults (currency respects minor units, including
zero for JPY). Number grouping true/default respects the locale's minimum grouping
digits; false disables grouping entirely. Compact, currency, and percent also
respect locale minimum grouping digits. Locale defaults to the device locale; timeZone defaults to the
device zone. Overrides accept a simple BCP 47 tag of at most 35 characters and an
IANA zone identifier of at most 128 characters. Shape validation does not prove
that the current engine supports a locale or zone.

Epoch milliseconds must be finite integers within the Date range. Strings are
`YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DDTHH:mm:ss[.fraction]Z` / a signed
`hh:mm` offset. Hours must be 00–23 and minutes/seconds 00–59; hour 24 and
leap second 60 are rejected. Invalid calendar dates, unzoned date-times, wrong types and
missing pointers display as the empty string. The host's pure formatter returns
undefined for invalid inputs; its resolver converts that to an empty string.

Relative formatting takes an injected nowMs snapshot; it never reads the real
clock. Choose the largest elapsed threshold not exceeding abs(input-nowMs):
year=365 days, month=30 days, day=24 hours, hour=60 minutes, minute=60 seconds,
second=1000 ms. Truncate toward zero. Under one second uses localized "now".
There are no weeks or calendar-month arithmetic. Callers resolve entry locale
and zone overrides before formatting, and keep the clock snapshot fixed when
reproducible output is required.

`prototype_format_v1` gates either derive map, including empty maps, before show
or the complete patch result. Renderers must implement this capability before
advertising it. Shared `derive/formatters.json` cases define parity: normalize
U+202F and U+00A0 to plain space before comparisons. Exact cases pin supported
English output; structural cases allow documented CLDR differences in foreign
currency symbols, narrow relative abbreviations, zero-relative wording and
non-English data. Add engine overrides only after measuring an actual platform
difference; the fixture note records the divergence policy and unit thresholds.

`dateTime`, `duration`, `plural`, and `fileSize` remain follow-ups and are invalid
format kinds. No dependencies are needed: the host uses Intl.NumberFormat,
Intl.DateTimeFormat and Intl.RelativeTimeFormat.

## Platform namespaces (#15257)

Prefer portable fields, portable theme tokens, then `theme.design`; reserve `ios`/`android`
for native semantics. Each closed contract field has a `why`. Both renderers advertise
`prototype_platform_namespace_v1` (iOS 17+). Foreign blocks are accepted and ignored with
paths in `platformNotes`; unknown fields are rejected on either platform. Window/theme
namespace blocks have no applicable node and are reported as ignored. The four node glass fields
require only `prototype_glass_v1` on iOS; mixing any other iOS key requires
`prototype_platform_namespace_v1` as well. Android ignores foreign glass fields
with their individual paths in `platformNotes`.

Android `indication` controls node clickable feedback (`ripple` or `none`); motion-off
still disables feedback. Stack `predictiveBack.style` preserves the normal pop for
`default`, uses horizontal movement and fade for `crossActivity` within the prototype
activity, and snaps without predictive scrubbing for `none`. Reduced motion still wins.

iOS `buttonStyle` applies `.glass`/`.glassProminent` on iOS 26+, using bordered buttons
below 26 with a substituted note. `hover` applies lift/highlight on iOS 17+ and is render-only.
The renderer's tab bars, app bars and sheets are custom drawn to retain per-item identifiers;
`tab.role`, `bottomAccessory`, `navigationTitle` and `sheet.sizing` are reported as ignored.
`bottomAccessory` is node-only and structurally validated; its descendants provide no targets,
references or capabilities on either renderer. iOS ignores all Android fields.

## Glass surfaces and scroll edges

`style.surface` is a closed enum containing only `"glass"`. Optional strict
`style.glass: {variant?, tint?, interactive?}` takes `regular|clear` (default
regular), an existing hex/role/light-dark colour slot, and a boolean (default
false). `glass` without `surface: "glass"` in the same style is invalid, including
`styleWhen` entries; conditional glass options must repeat the surface. `cornerRadius` chooses the
shape; omission uses a capsule. Base and conditional styles require
`prototype_glass_v1`; bundles must list every required capability.

`scroll.edgeEffect: "soft"|"hard"|"none"` requires
`prototype_scroll_edge_effect_v1`. iOS 26 uses the native scroll edge style;
iOS 17–25 reuse the scrollability-aware `fadeEdges` mask, 24 dp for soft and
8 dp for hard. Authored `fadeEdges` lengths override those defaults; `none`
disables only the default fallback mask or native effect. Explicit `fadeEdges`
remain applied on every supported iOS version. Android accepts the contract but does not advertise or
render edgeEffect until its renderer slice; Android below API 31 refuses glass.

In `ios`, `glassGroup: {spacing}` accepts finite 0–200 dp on column, row, box,
flow, grid, list and listItem containers. Descendant glass nodes with `shared`
keys use group-scoped glassEffectID, independently of visibility-pair matching;
nested groups establish a new namespace. Keys must be unique within the nearest
group and cannot also belong to visibility pairs. Under repeat, including on the
repeated node, a glass shared key must be a template referencing repeat.key.
Existing capability rules still apply. `glassUnion` is a 1–64 character ASCII id token
(`[A-Za-z_][A-Za-z0-9_]*`); `glassTransition` is matchedGeometry, materialize or
identity. Both require a base glass surface on the same node.
`backgroundExtension: true` is image-only and does not require the image itself
to be glass. All four fields are node-only (invalid in window.ios/theme.ios) and
require only the glass capability on iOS; Android ignores them with field paths
in platformNotes.

Reduce Transparency and Increase Contrast are handled by the system's Liquid
Glass implementation. Verification pins accessibility settings and checks
structure and bounds, rather than glass pixels. Group merging, morphs, unions,
image extension and accessibility appearance still require iOS 26 simulator
verification. Android real blur, clear-variant approximation and ignored
interactive semantics belong to its renderer slice and must report any
approximation in platformNotes on devices advertising glass.

### Motion tokens

`animate.tempo: "fast" | "default" | "slow"` requires `prototype_motion_tokens_v1`
and cannot be combined with `durationMs` or `easing`. The contract's `motionTokens`
table selects a physical spring by scheme (`motion: "standard"` by default, or
`"expressive"`), property role and tempo. `easing: "spring"` selects the default
tempo of that scheme. Spatial properties are offset, scale, rotation, cornerRadius,
elevation, shadowColor, padding, border width and dp width/height; alpha, background,
color and border color use critically damped effects springs.

| Scheme / role         | Damping ratio (fast / default / slow) | Stiffness (fast / default / slow) |
| --------------------- | ------------------------------------- | --------------------------------- |
| standard spatial      | 0.9 / 0.9 / 0.9                       | 1400 / 700 / 300                  |
| expressive spatial    | 0.6 / 0.8 / 0.8                       | 800 / 380 / 200                   |
| either scheme effects | 1 / 1 / 1                             | 3800 / 1600 / 800                 |

Compose uses `spring(dampingRatio, stiffness)`. SwiftUI uses
`interpolatingSpring(mass: 1, stiffness: k, damping: 2 * dampingRatio * sqrt(k))`,
so both renderers use the same physical spring. Reduced motion snaps spatial
changes and retains effects; motion off snaps everything. Existing motion v2/v3
capability requirements still apply; iOS advertises the token capability but
continues to refuse those broader features until its corresponding capabilities
are available.
