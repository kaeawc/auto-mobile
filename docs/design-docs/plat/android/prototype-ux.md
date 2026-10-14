# Agent-authored prototype specification

This is the current, unversioned contract for #9296, child of #9295. Compose
rendering on Android (#9299, #9300), asset transport (#9301), wire messages
(#9298), the `prototype` MCP tool (#9302) and the
[iOS simulator agent](../ios/prototype-agent.md) implement it; the iOS agent's
[feature support table](../ios/prototype-agent.md#feature-support) lists what is Android only
(`display`, `window.layer: "app"`, `window.persistence: "device"`, `inspect`, idle TTL).
No code,
expressions, URLs, image bytes, or migration instructions are accepted in a
spec.

## Owner decisions

The 2026-10-04 decisions supersede the issue's earlier proposals:

- Envelope: `{ id, window, data?, state?, root }`, with no `specVersion`. An older or
  newer shape is rejected rather than migrated.
- Every object is strict: unknown properties, unknown node/action types, explicit
  null for optional fields, and wrong types reject the entire spec with a path.
- Scroll supports both axes. Pager is horizontal, full-page only, with no axis.
- Navigation includes `tabBar` and author-positioned `bottomNav`, bound to a pager
  or a number state key.
- Windows are edge-to-edge. Safe-area padding is an explicit node opt-in.
- A `sheet` window and a modal `bottomSheet` node are separate concepts.
- Built-in icons come from a closed list (the bundled Material icon set); other artwork uses image assets.

Earlier decisions still apply: the renderer is Compose; sizes and positions use
dp; prototype opacity is a percentage; app-element anchoring is supported; observe
includes prototype nodes by default; existing tap/text tools target prototype nodes;
screenshots come from observe, with no separate screenshot tool. Focus management
belongs to the window host: accessibility set-text does not require focus, while
human keyboard input does (the later device findings in #9300 supersede the older
blanket focusability proposal).

## Envelope and limits

| Property | Type / meaning                                                     |
| -------- | ------------------------------------------------------------------ |
| `id`     | Required nonempty prototype identifier string.                     |
| `window` | Required window configuration below.                               |
| `data`   | Optional agent-owned read-only nested JSON object; see Data model. |
| `state`  | Optional flat object of string, finite number, or boolean values.  |
| `motion` | Optional `none` or `standard` (default). See Motion below.         |
| `root`   | Required single node.                                              |

All numeric values are finite. State keys (including action/binding/condition
keys) match `[A-Za-z_][A-Za-z0-9_]{0,63}`. No nested state, arrays, or nulls.
Prototype IDs, pager IDs, tags, event names, and asset IDs are opaque nonempty
strings; they do not share the state-key restriction.

| Constant                           | Value           | Counting rule                                                                                      |
| ---------------------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| `MAX_PROTOTYPE_NODES`              | 2000            | Includes root and every child/page/sheet child; `repeat` templates count once per instance.        |
| `MAX_PROTOTYPE_DEPTH`              | 24              | Root has depth 1; only node nesting counts.                                                        |
| `MAX_PROTOTYPE_IMAGES`             | 32              | Counts image nodes and nav item image uses, including hidden ones; repeated asset IDs count again. |
| `MAX_PROTOTYPE_SPEC_BYTES`         | 1048576 (1 MiB) | UTF-8 bytes of raw JSON, including whitespace.                                                     |
| `MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES` | 4096 (4 KiB)    | Conservative compact JSON byte budget for each emit payload; numbers reserve 32 bytes.             |

Navigation item `image` uses also count toward `MAX_PROTOTYPE_IMAGES`. Assets have
separate transport and decoded-memory limits in #9301. These spec limits keep
parsing/layout work bounded without limiting image pixel data inside this file.
Emit payload nesting has a separate `MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH` of 24
(root payload depth 0). To avoid different number spellings in JVM/JS decoders,
the byte budget counts each finite number as 32 bytes; strings, keys, booleans,
null, punctuation, and separators use compact JSON UTF-8 bytes. This bounds
actual compact serialized size and can conservatively reject numeric-heavy
payloads. Raw number token length and whitespace are governed by the spec-byte
limit. Nonfinite JSON numbers are rejected, including inside emit payloads.

Every onTap list has 1–32 actions; tab bars have 1–32 items; bottom navigation has
2–5 items; sheet detents have 1–8 entries.

The single structural rule source is `schemas/prototype-spec-contract.json`,
imported by TypeScript and packaged as a JVM protocol resource. TypeScript's
concrete Zod schema supplies inferred types and the final typed decode. Kotlin
uses kotlinx.serialization models with sealed discriminated hierarchies. Use
`validatePrototypeSpec` / `PrototypeSpecValidator.validate` as the complete entry
points: structural validation, limits, and cross-references precede typed decode.
Do not bypass them with a model decoder. Untagged dimension, detent, page-target,
and scalar unions have explicit Kotlin serializers; only arbitrary emit payloads
retain JsonElement. Validated integer model fields normalize decimal/exponent
spellings before Kotlin decoding (e.g. `100.0` and `1e2` both mean 100). The protocol module has no API-dump
plugin or API-check task; its published artifact includes the contract resource.

## Data model (#11673)

`data` is an optional top-level plain JSON object, owned by the agent and read-only on the device.
Values may be objects, arrays, strings, finite numbers and booleans; null and non-JSON values are
invalid. Object keys are arbitrary strings. `state` remains the user-owned scalar map: `setState`,
`toggle`, `increment`, `decrement` only target declared state keys, including per-row keys. A key
present only in data fails like any undeclared state key. A new full `show` replaces data.

Limits come from `schemas/prototype-spec-contract.json`: `MAX_PROTOTYPE_DATA_BYTES` (262144),
`MAX_PROTOTYPE_DATA_DEPTH` (8), `MAX_PROTOTYPE_DATA_ARRAY_ITEMS` (500), and
`MAX_PROTOTYPE_DATA_POINTER_LENGTH` (256 UTF-16 code units). Data is depth 1; only containers add
depth. The byte cost reuses the emit payload cost: 32 bytes per number, compact JSON UTF-8 for
strings/booleans/keys, punctuation and separators. Every number costs 32 bytes regardless of its
digits, so numeric-heavy data reaches the byte limit before its serialized size does.

CtrlProxy and the iOS prototype agent both advertise `prototype_data_model_v1`.

Pointers are nonempty RFC 6901 paths relative to data, matching `^(?:/(?:[^~/]|~[01])*)+$`.
Split after the leading slash; decode `~1` to `/`, then `~0` to `~`. Resolution follows exact own
object members, including empty or numeric-looking keys. Array indices match `0|[1-9][0-9]*` and
must be in bounds; `01`, `-`, `1.0`, negative indices and traversal through a scalar are missing.
No data means every path is missing. `/a/` accesses the empty key inside `a`.

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

- `repeat.items: {path}` must resolve to an array of objects (empty is valid). Only scalar members
  with field-shaped names are projected into items. `repeat.key` names a field every item has;
  its rendered values must be unique, for literal lists too.
- `MAX_PROTOTYPE_REPEAT_PATH_CELLS` bounds the sum across path-bound repeat containers in
  pre-order after component expansion, including empty templates. Each instantiated object item
  costs the number of projected scalar members, or one cell if it has none. Literal repeats do
  not count. After the three path-source checks, exceeding this budget fails at
  `<node>.repeat.items.path` with `Repeat path cell limit exceeded`, before template projection.
  Cell counts and immutable projected lists are cached by pointer within each validation call.
- `MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH` (16384 UTF-16 code units) bounds the sum of
  replacement lengths per bindable field at each substitution stage: data in text-kind fields,
  then repeat in every bindable field for each item, including repeat placeholders inserted by
  data. Literal characters and unresolved repeat placeholders contribute zero; state placeholders
  are not validated because state can change after show.
  `MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL` (4194304 UTF-16 code units) also bounds rebuilt text
  per validation: each recognized data stage and each repeat item charges authored stage length
  plus replacement length, including literal units and placeholder tokens. Inside a repeat, a
  data-resolved field is also charged once per item, even without repeat placeholders. Purely
  literal fields and state placeholders are not charged. Crossing the total fails at the field path
  with `Substituted text total limit exceeded`.
  During state interpolation, a replacement that would exceed the per-call substitution limit stays
  as written, and later placeholders may still substitute.
- `{data:/pointer}` binds only the text-kind fields repeat already binds: text, button/FAB labels,
  segmented option labels, app bar title/navigation/action labels, dialog title/text/button labels,
  and snackbar text/action label. Missing, object or array values become empty text. Other braces
  stay literal. A data string is inserted as plain text before repeat and state binding, so
  `{item.x}`, `{index}` or `{key}` inside it bind afterwards exactly like authored text.
  Data values cannot be escaped; inserted strings are never scanned again for data placeholders.
  Pointers are untouched by component props.
- A condition uses exactly one of `key`, `data`, `all`, `any`, `not`. A data condition has exactly
  one comparison: `equals` (same scalar type and value), `notEquals` (its inverse, including missing
  or non-scalar), `gt` or `lt` (numbers only, otherwise false). `equals`/`notEquals` operands are
  literals; repeat placeholders there are rejected. `bottomSheet.openWhen` remains boolean state.

The host validates data and repeat paths; the device resolves authored bindings before repeat
expansion. All data uses require `prototype_data_model_v1`; an older device is refused
before uploads or show, with an update/relaunch hint. `status` reports the last successful show's
data next to state; `inspect` reports and adopts device data. Absent data is omitted; dismiss
clears it. Events never carry data.

````


`repeat.items` accepts a strict `{ "path": pointer }` alongside the unchanged literal list.
The path must statically resolve to an array of objects within the literal repeat's item maximum.
Empty arrays produce zero instances. Each item is projected to scalar members whose names match
`^[A-Za-z_][A-Za-z0-9_]{0,63}$`; nested members stay in data and are invisible to repeat templates.
Optional `repeat.key` names a projected field present in every item; identities use scalar text
rendering and must be unique (7 and "7" collide). It also works on literal lists. Existing
per-item field, state-key, action and expanded node/image checks still run. Repeat templates
cannot nest repeats or pagers.

`{data:<pointer>}` is recognised by a plain scan to the next closing brace; invalid placeholders
stay literal and never make text invalid. It binds only text-kind fields: `text.text`,
`button.label`, `fab.label`, `segmentedButton.options[].label`, `topAppBar.title`,
`topAppBar.navigationIcon.label`, `topAppBar.actions[].label`, `dialog.title`, `dialog.text`,
`dialog.confirm.label`, `dialog.dismiss.label`, `snackbar.text`, `snackbar.action.label`.
It never binds state keys, operands, emit names/payloads or content descriptions. Scalars render
normally (integral numbers without a decimal point or exponent); missing/object/array values
render empty. Bind authored data text first, repeat placeholders second, state interpolation
last. Inserted data strings and repeat item values are never rescanned for data placeholders.
A data string is inserted as plain text: repeat placeholders (`{item.x}`, `{index}`) and state
placeholders (`{key}`) inside it bind afterwards exactly like authored text. Data values cannot
be escaped.
Component props are never bound in `repeat.items.path` or a condition's `data`; `repeat.key`
passes through expansion unchanged.

Conditions select exactly one of `key`, `data`, `all`, `any`, `not`. A `key` or `data` form requires
exactly one of `equals`, `notEquals`, `gt`, `lt`. Data `equals` needs the same scalar type and value
(numbers by value; -0 equals 0). `notEquals` is its inverse, including missing/non-scalar values.
`gt`/`lt` compare numbers only, otherwise false. `equals`/`notEquals` are literals: a repeat
placeholder in a data operand is rejected; state operands still bind. `bottomSheet.openWhen`
keeps its boolean `{key, equals}` form. Devices resolve authored bindings before repeat
expansion: path items are projected, text is bound, conditions become in-memory constants.
The host performs validation only, preserving authored bindings on the wire.

On Android, CtrlProxy keeps the original validated spec for state-write validation, persistence,
replay and status. Each render mapping entry point (`mapPrototypeSpec`
and the runtime's incremental mapper) resolves the authored spec. The runtime's mapper caches the
resolved root per (root, data) identity pair and the resolved spec per authored spec instance, so
state writes and repeated `renderModel()` calls do not re-resolve. State writes trigger one mapping
pass; unchanged calls reuse the same model. The controller guards the authored tree, checks authored
anchors before validation to preserve error precedence, validates the authored spec, then resolves
it and guards the resolved tree, checking anchors again when resolution changes the root. A show
therefore resolves during controller validation, its one-off `mapPrototypeSpec` render request and
its runtime's incremental mapping. The validator's `MAX_PROTOTYPE_REPEAT_PATH_CELLS` limit bounds
resolution work.
Appearance and anchor layout consume the resulting render tree. `repeat.key` is validated and
carried on the model; Compose rows retain positional identity in this slice. Keyed identity lands
with patch (#11675), when reordering becomes observable. CtrlProxy advertises
`prototype_data_model_v1`, and its inspect entries report the shown spec's original `data` beside
state, omitting it when absent.

### Validation paths and reporting

Data is walked depth-first, with sorted object keys and array index order. At each container,
depth precedes array length, then children; the byte check runs last.

| Path | Message |
| --- | --- |
| `data` | `Expected object` when the root is not a plain object |
| Offending data container | `Data depth limit exceeded` or `Data array limit exceeded` |
| Offending value, e.g. `data.orders[0].title` or `data["a b"]` | `Invalid data value` |
| `data` after the walk | `Data byte limit exceeded` |
| Pointer field | `Invalid pointer value` |
| `<node>.repeat.items` | `Invalid union value` for neither array nor object |
| `<node>.repeat.items.path` (in this order) | `Repeat path does not resolve to an array`; `Repeat path resolves to more than 128 items`; `Repeat path item <i> is not an object`; `Repeat path cell limit exceeded` |
| Bindable field | `Substituted text total limit exceeded` (reduce bindable fields, replacement lengths or repeat items; `MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL`) |
| Authored bindable field, e.g. `root.children[0].text` or `root.children[0].onTap[0].name` | `Substituted text length limit exceeded` (after unknown repeat fields, before bound key/empty emit checks) |
| Referencing template string | `Unknown repeat field "x"` (non-scalar members count as absent) |
| `<node>.repeat.items.path` | `Bound state key "<k>" is invalid (repeat item <i>)`; literal repeats keep `<node>.repeat.items[i]` without the suffix |
| `<node>.repeat.key` | `Unknown repeat field "<key>"`; `Duplicate repeat key "<text>" (items <i> and <j>)`, first colliding pair |
| Condition `.key` | `Exactly one of key, data, all, any, not is required` |
| Condition comparison field | `Requires key or data`; `Exactly one of equals, notEquals, gt, lt is required` |
| Condition `.equals` / `.notEquals` in bindable visiting order | `Repeat placeholder in a data condition operand is not supported` |
| `<node>.repeat` | Existing expanded node/image limit errors |

All data-model uses require `prototype_data_model_v1`: top-level data, path items, repeat.key,
data conditions or recognised text placeholders. The host refuses before any asset upload or
show when the device does not advertise it. The refusal identifies the first usage field (data
first, then node fields in document order, depth-first), counts other fields and gives an update
or iOS relaunch hint plus a literal-content fallback.

`inspect` reports optional data beside state, absent for specs without data. Host-local `status`
remembers a deep copy of the last successful show's data, replaces it on inspect adoption, and
clears it with the prototype. Events never carry data.

## Theme

Optional top-level `theme` sets the Material scheme every built-in component draws
from. At least one of its fields is required:

| Field                         | Meaning                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
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
- **Window metadata.** `prototypeOpaque` follows what is drawn. The root background and the window
  scrim are resolved in the mode the show resolved to and count as solid only when the result is
  fully opaque. An opaque role counts; the `scrim` role in a scrim slot never does. The root
  counts only when it is drawn over the whole window (#11408): `width` and `height` both `fill`,
  no `anchor` (an anchored root is laid out at its anchor's rectangle, in every placement),
  no `maxWidth`/`maxHeight` cap and no `aspectRatio`, no non-zero `offset`, no rounded corner
  (`cornerRadius` absent, `0`, `none` or all corners `0`) and no `pressScale` below one. A root
  that fails any of these lets the app show at an edge or corner, so only an opaque fullscreen
  scrim behind it can still make the window opaque. A chromeless fullscreen window can report
  `prototypeOpaque: true` when opacity is 100 and its root or scrim is solid; a fullscreen window
  with the translucent dismiss bar still reports false.

### Live appearance (#11221, `prototype_appearance_v1`)

The controller resolves the mode once per show and keeps it current. That one value drives the
host chrome (dismiss bar, Close control), the window scrim, every colour and image pair in the
content and the window metadata, so they cannot draw in different modes. No window reads its own
Compose configuration for it, which is why a window created from a display or app-layer window
context follows the same value as one on the service context.

- **Override.** `show_prototype` takes a top-level `appearance`: `"device"` (the default when
  absent), `"light"` or `"dark"`. It stands in for the system setting only: it decides a spec with
  `theme.mode: "system"` and a spec whose mode would otherwise fall through to the device. It does
  not beat an explicit `light`/`dark` mode, a flat `background`/`surface` override or an authored
  opaque background. It belongs to the show: a later show of the same id without the field follows
  the device again. An unknown value fails the request and leaves what is showing untouched.
- **Re-theme.** The mode is resolved again after each interaction (a pager page or a `styleWhen`
  state can change the background it is inferred from) and on every configuration change (the
  device's night mode; on API 31+ the Material You palette, so a `colors.source: "device"` scheme
  is read again after a wallpaper change). The window, the runtime, authored state, pager pages
  and text-field contents are kept; only colours change. A prototype hidden by the lock screen or
  because its app left the foreground is resolved too, and returns in the current mode.
- **Event.** When the resolved mode changes, the device sends one `prototype_event` with
  `kind: "appearance_changed"`, `name: null` and `payload: {mode, source}`, on the normal
  sequence, buffering and replay path. Nothing is sent when the mode stays the same (a repeated
  configuration change, a device flip under an explicit mode or an override, a palette change), nor
  for the show itself, whose result carries the mode.
- **Report.** A successful `show_prototype` result and each `inspect_prototypes` entry carry
  `appearance: {mode, source, deviceDark}`. `mode` is `light` or `dark`. `source` names the step
  that decided it: `explicit`, `override`, `roleLuminance`, `authoredBackground` or `system`
  (`theme.mode: "system"` reports `system`, or `override` when the show pinned it). `deviceDark` is
  the device's own setting whatever decided the mode. The host's `prototype` tool reports it only in
  device answers (show, inspect); its host-local `status` omits it (#11416). The prototype's own window entry in a
  hierarchy capture carries the same object as `prototypeAppearance`, next to `prototypePlacement`
  and `prototypeOpaque`; an APK without `prototype_appearance_v1` omits it.

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
| `transition`         | Optional `none`, `fade`, `expand` or `slide`: the `visibleWhen` enter/exit. See Motion.                                                      |
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

| `type`            | Node-specific properties                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `box`             | Required `children` array, possibly empty; children stack. Optional `repeat` (see List templates below).                                                                                                                                    |
| `row`             | Required `children` array, possibly empty; horizontal layout. Optional `repeat` (see List templates below).                                                                                                                                 |
| `column`          | Required `children` array, possibly empty; vertical layout. Optional `repeat` (see List templates below).                                                                                                                                   |
| `text`            | Required `text` string, possibly empty.                                                                                                                                                                                                     |
| `image`           | Required opaque `asset` string; optional `contentScale`: `fit` (default), `crop`, `fill`.                                                                                                                                                   |
| `icon`            | Required built-in `name` below; optional `variant` (`filled`, `outlined`, `rounded`, `sharp`, `twoTone`).                                                                                                                                   |
| `spacer`          | No node-specific properties; size comes from style.                                                                                                                                                                                         |
| `textField`       | Required `stateKey` naming an initialized string state value; optional `placeholder` string, default empty.                                                                                                                                 |
| `switch`          | Required `stateKey` naming an initialized boolean state value; optional nonempty `label`.                                                                                                                                                   |
| `checkbox`        | Required `stateKey` naming an initialized boolean state value; optional nonempty `label`.                                                                                                                                                   |
| `button`          | Required nonempty `label`; optional `variant`: `filled` (default), `tonal`, `elevated`, `outlined`, `text`; optional leading `icon` (built-in name). Taps run `onTap`.                                                                      |
| `radioGroup`      | Required `stateKey` naming an initialized string state value; required `options`, 2 to 16 `{value, label}` entries with nonempty, unique `value`s.                                                                                          |
| `listItem`        | Required nonempty `headline`; optional nonempty `supporting`, optional `leadingIcon` (built-in name), optional `trailing`: `{type: switch\|checkbox, stateKey}` bound to an initialized boolean, or `{type: icon, name}`. Taps run `onTap`. |
| `slider`          | Required `stateKey` naming an initialized number within `min`..`max`; required finite `min` < `max`; optional `step`, optional nonempty `label`.                                                                                            |
| `chip`            | Required nonempty `label`; optional `variant`: `assist`, `filter`, `input`, `suggestion`; optional `stateKey` naming a boolean (a filter chip only).                                                                                        |
| `card`            | Required `children` array; optional `variant`: `filled` (default), `elevated`, `outlined`.                                                                                                                                                  |
| `iconButton`      | Required built-in `icon`; optional `variant`: `standard` (default), `filled`, `tonal`, `outlined`. Taps run `onTap`.                                                                                                                        |
| `fab`             | Required built-in `icon`; optional nonempty `label` (an extended FAB); optional `size`: `small`, `regular` (default), `large`, only without a `label`. Taps run `onTap`.                                                                    |
| `segmentedButton` | Required `stateKey` naming an initialized string state value; required `options`, 2 to 5 `{value, label}` entries with nonempty, unique `value`s. Single select.                                                                            |
| `topAppBar`       | Required nonempty `title`; optional `variant`: `small` (default), `centerAligned`, `medium`, `large`; optional `navigationIcon` and 1 to 3 `actions`, each `{icon, label, onTap?}`.                                                         |
| `divider`         | Optional `orientation`: `horizontal` (default), `vertical`.                                                                                                                                                                                 |
| `badge`           | Optional nonempty `text` (a count or short label); without it a small dot.                                                                                                                                                                  |
| `progress`        | Optional `variant`: `linear` (default), `circular`; optional `stateKey` naming an initialized number within 0..`max` (determinate); optional `max` > 0, default 1, only with `stateKey`. Unbound is indeterminate.                          |
| `dialog`          | Required `openWhen` and `confirm`; optional nonempty `title` and `text`, optional `icon`, optional `dismiss`, optional single `child`. Buttons are `{label, onTap?}`.                                                                       |
| `snackbar`        | Required `openWhen` and nonempty `text`; optional `action` button `{label, onTap?}` and `durationMs` (1 to 600000, self-closing).                                                                                                           |
| `timePicker`      | Required distinct `hourKey` and `minuteKey` naming initialized integers 0..23 and 0..59; optional `is24Hour` boolean, default the device setting.                                                                                           |
| `datePicker`      | Required `stateKey` naming an initialized `YYYY-MM-DD` string, a real date in years 1900..2100.                                                                                                                                             |
| `scroll`          | Required single `child`; optional `axis`: `vertical` (default), `horizontal`. Free scrolling, with no page snapping.                                                                                                                        |
| `pager`           | Required `id` and nonempty `children` array. Each child is one full-size page; horizontal swipe only.                                                                                                                                       |
| `tabBar`          | Required `items`; exactly one `pager` or `stateKey`; optional `scrollable` boolean, default false.                                                                                                                                          |
| `bottomNav`       | Required 2–5 `items`; exactly one `pager` or `stateKey`. Author positions it, typically last in a column.                                                                                                                                   |
| `bottomSheet`     | Required single `child`, `openWhen`, and `detents`; optional `scrim`, `dragHandle`, `dismissOnSwipe`.                                                                                                                                       |

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

`switch`, `checkbox` and `button` are Material 3 components (#10439, first
slice). A switch or checkbox draws the bound boolean; a tap anywhere on the
control, including its label, flips that state value, emits a `change` event
(`{key, value}`) like a text field or `stateKey` selection, and then runs the
node's own `onTap`, if any. A `setState` that would make the bound value
non-boolean is rejected like any other binding type change. A button runs its
`onTap`; without one it is drawn but inert. Each component is one accessibility
node carrying its label as text, a native role (`Switch`, `Checkbox`,
`Button`), and for switch and checkbox the checkable/checked state, so `observe`
reports them as controls and `tapOn` by `testTag` or label toggles or presses
them. Each reserves the Material 48 dp minimum touch target.

`slider`, `chip` and `card` are the second slice. A slider is bound to a number
state key that must already lie within `min`..`max`; `step`, when given, must
be positive and divide `max - min` evenly (the thumb snaps to those positions,
otherwise it is continuous). Dragging, or an accessibility set-progress action,
stores the snapped number, emits `change` (`{key, value}`) only when the value
moved, and then runs the node's `onTap`. It is one accessibility node carrying
its label and a progress range (current, `min`..`max`, steps), so `observe`
reports the value as range info. A chip with a `stateKey` is a filter chip: it
toggles that boolean like a switch, emits `change`, then runs `onTap`, and
reports the `Checkbox` role with its checked state. A chip without one is an
assist chip: a `Button` that runs `onTap`. `variant: filter` requires a
`stateKey` and `variant: assist` forbids one; `input` and `suggestion` chips are
later slices. A card is a Material container whose `children` are laid out as a
column; its `variant` selects filled, elevated or outlined, a `style.background`
overrides the container colour, and an `onTap` makes the whole card clickable.
A card has no accessibility label of its own.

`radioGroup`, `listItem` and the button extras are the third slice of #10439. Button
`tonal` and `elevated` are Material's filled-tonal and elevated buttons; an
`icon` draws before the label. A radio group draws one Material radio row per
option; a tap on a row (or its label) sets the bound string to that option's
`value`, emits `change` (`{key, value}`) only if the value changed, and then runs
the group's own `onTap`. A bound value matching no option leaves every option
unselected. Each option row is its own accessibility node with the `RadioButton`
role, its label as text and a selected state; when the group has a `testTag`, the
option's tag is `<testTag>.<value>`. A list item is one accessibility node whose
text is the headline (and supporting line). With a trailing switch or checkbox it
is toggleable with the `Switch` or `Checkbox` role and checked state: a tap
anywhere on the row flips the bound boolean, emits `change`, then runs `onTap`.
Otherwise a row with `onTap` is a `Button` that runs it, and a row without is
inert. A trailing `icon` is decorative.

`iconButton`, `fab`, `segmentedButton`, `topAppBar`, `divider`, `badge`,
`progress`, `dialog`, `snackbar`, `timePicker`, `datePicker` and the `input` and
`suggestion` chips are the last slice of #10439. Icon buttons and FABs are
`Button` nodes that run `onTap`, labelled by `contentDescription`, else an
extended FAB's `label`, else their icon name. A segmented button behaves like a
radio group: each segment is its own selectable node tagged `<testTag>.<value>`,
and a tap binds the string key to its value, emits `change` if it moved, then
runs `onTap`; multi-select segments are not offered (use filter chips). Input and
suggestion chips, like assist chips, only run `onTap` and cannot bind a key.
A top app bar's text is its title (state placeholders are resolved); its
navigation icon and actions are icon `Button` nodes labelled by their `label` and
tagged `<testTag>.navigation` and `<testTag>.actions.<index>`, each running its
own `onTap`. It draws no system-bar inset of its own; add `safeAreaPadding`. A
divider has no accessibility node unless tagged. A badge reads as its `text`. A
bound progress indicator is determinate and reports `value / max` as progress
range info over 0..1; an unbound one reports indeterminate progress.

`dialog` and `snackbar` open while `openWhen` holds, like `bottomSheet` (an
existing key must be boolean), and are drawn above the whole author tree inside
the prototype window, never as a separate window. A dialog is modal: a scrim tap
closes it, and so does either button. While it is open the page behind it is
removed from the accessibility tree (`clearAndSetSemantics` on the page), so
`observe` and screen readers see only the dialog, as on iOS and as touches
already behave; a closed dialog leaves the page as it was. Closing writes `!equals` to the key and
emits `change`; a button then runs its own `onTap`. Its title is its text, its
`text` is a separate text node, `child` sits between the text and the buttons,
and the buttons are tagged `<testTag>.confirm` and `<testTag>.dismiss`. A snackbar
sits at the bottom of the window and is not modal: the page stays in the
accessibility tree. It stays until closed unless it
sets `durationMs` (an integer, 1 to 600000): it then closes itself that long after it
opens, by writing `!equals` to its `openWhen` key like any other close. The timer is
wall-clock time, not scaled by the animator duration. Its `action`
(tagged `<testTag>.action`) closes it, then runs `onTap`. Title, text and
snackbar text resolve state placeholders, so `Alarm set for {hour}:{minute}`
reads the bound time.

A time picker is Material's dial picker bound to two integer keys. A change
stores both keys together and emits one `change` event (`{keys, values}`, or
`{key, value}` when only one moved), then runs `onTap`. A date picker is
Material's calendar bound to a `YYYY-MM-DD` string; picking a day binds the key,
emits `change`, then runs `onTap`. Both report their value as the accessibility
state (`07:30` in 24-hour form, `2026-10-08`), and a new bound value from a
re-show or `setState` moves the picker. A `setState` that would put an out of
range hour, minute or date into a bound key is rejected.

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

## Style

All properties are optional. Sizes, padding, offsets, radii, and spacing use dp.
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
| `border`                                         | `{width, color}`; nonnegative dp width; `color` takes hex or a color role name.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
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

## Icons and images

Built-in Material names are the 2,075 icons of `material-icons-extended`, written
in snake_case (`home`, `timer`, `bedtime`, `alarm_add`, `add_a_photo`). The closed list is the
`iconName` definition in `schemas/prototype-spec-contract.json`, shared by the TypeScript
and JVM validators. The renderer already ships that library, so the full set adds no APK
size beyond the list itself (about 10 KB measured). An icon node may set `variant`:
`filled` (default), `outlined`, `rounded`, `sharp` or `twoTone`; nav items are always
filled. Material Symbols names with no `material-icons-extended` counterpart are not
available, and neither are symbol `weight` or `fill` axes, which would need a bundled
variable font. Custom text fonts do ship, as host-uploaded assets (see "Custom fonts"
below).

Unknown names reject the spec. #9301 pins ID-based assets, but no nested reference
shape, so image nodes use `{type: "image", asset: "opaque-id"}` and nav items
use `image: "opaque-id"`. Asset existence is not validated here. A missing asset
renders a visible placeholder and reports a result under #9301; image bytes,
MIME types, URLs, cache paths, and screenshot handles are not spec properties.

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

`show_prototype` lists the referenced ids the device has no copy of in
`prototype_result.missingAssets`, in first-use order. It is a warning: `success` stays true
and the prototype is shown with placeholders, so the host can upload the assets and the
nodes fill in without another `show`. The field is omitted when nothing is missing and
from every other result, so older hosts see the frame they always did. An id the store
lists but whose file was evicted is not reported at `show` time; it renders the
placeholder. Dismissal clearing is unchanged.

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

A node's optional `transition` picks the `visibleWhen` enter/exit: `none`
(instant), `fade`, `expand` (grow/shrink) or `slide` (vertical slide with a
fade). Absent keeps the default fade + expand. It has no effect on nodes
without `visibleWhen`, or when motion is off.

A style `pressScale` (0.5–1) shrinks a tappable node while it is pressed. With
motion on it animates with a short spring; with `motion: "none"` or animator
scale 0 it snaps, so a screenshot taken mid-press is still deterministic.

## Actions and state

| Action `type` | Properties                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emit`        | Required nonempty `name`; optional arbitrary JSON `payload` up to the 4 KiB conservative compact JSON budget (null and nested JSON allowed).               |
| `setPage`     | Required existing `pager` ID; required `page`: `next`, `prev`, or nonnegative integer index up to 2147483647. Renderer clamps to available pages.          |
| `setState`    | Required state `key` and scalar `value`; creates or replaces a key.                                                                                        |
| `toggle`      | Required `key` that the spec's `state` declares as a boolean; flips it.                                                                                    |
| `increment`   | Required `key` that `state` declares as a finite number; adds optional finite `by` (default 1, negative values decrement). Non-finite results are ignored. |
| `decrement`   | Same as `increment` but subtracts `by` (default 1); `decrement` with a negative `by` adds. Non-finite results are ignored.                                 |
| `dismiss`     | No additional properties.                                                                                                                                  |

No scripts, callbacks, expressions, or implicit navigation. `setState` must
preserve any text-field, selection, or sheet binding's scalar type at runtime;
renderer enforcement is part of #9300. Event sequence and transmission are
#9298/#9303. Dismissal does not remove the host's safety responsibilities.

### Conditions

A condition is exactly one of these forms. `visibleWhen` takes any of them;
`bottomSheet.openWhen` keeps the boolean `{key, equals}` form.

| Form                       | Holds when                                                               |
| -------------------------- | ------------------------------------------------------------------------ |
| `{key, equals: scalar}`    | The state value is exactly equal (same type). A missing key never holds. |
| `{key, notEquals: scalar}` | The state value differs, including when the key is missing.              |
| `{key, gt: number}`        | The state value is a number greater than `gt`. Any other type is false.  |
| `{key, lt: number}`        | The state value is a number less than `lt`. Any other type is false.     |
| `{all: [condition, ...]}`  | Every member holds. One to 16 members.                                   |
| `{any: [condition, ...]}`  | At least one member holds. One to 16 members.                            |
| `{not: condition}`         | The member does not hold.                                                |

Numbers compare by value, so a state of `-0` equals `0` on every platform (#11408).

Conditions nest to a depth of 8 (`MAX_PROTOTYPE_CONDITION_DEPTH` in the shared
contract). `key` takes exactly one comparison, and comparisons need `key`;
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
````

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
content (`/data`), state (`/state`) or one node by id (`replaceNode`). The host action,
wire contract and capability gate exist, but **no device advertises
`prototype_patch_v1` yet**. Every patch is refused before sending: update CtrlProxy
on Android, or relaunch the app with `launchApp prototype: true` on iOS when a
supporting agent is available; until then, send the whole spec with `show`.

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
containing only data ops and `replaceNode` ignore `baseRevision`. Any state op,
including `test`, requires `baseRevision`. A device supporting the capability
must refuse the whole patch with `conflict` if the user changed a touched state
key since that revision, returning the current revision and those keys' values.

There are at most 64 ops, the frame is capped at 1 MiB, and the resulting whole
spec must satisfy every spec/data limit, including node count and depth. The
host tracks a cloned copy of the device spec from the last acknowledged show,
with components expanded and anchors resolved. It applies ops to a copy and
runs the full validator before sending. Errors preserve deterministic paths.
The host validates state ops against the agent-declared state and leaves value
comparison for `/state` `test` to the device; its copy cannot know user edits.

Patches are FIFO per device, with one in flight at a time. A pending show makes
patch refuse as busy. Shows are not delayed by patches. If a dispatched show
and an acknowledged patch overlap, their device-side order is unknown: the host
forgets its spec, warns, and requires a further successful show before patching.
A failed dispatched show, dismissed event, successful dismiss, session release,
device removal or unbinding also ends tracking. An adopted different id ends
tracking; inspecting the same tracked id retains it. A timeout or connection loss after
patch dispatch is indeterminate and requires a new show. A failure before dispatch
keeps the tracked copy. An atomic device
refusal leaves the tracked copy unchanged. A successful patch refreshes shown
status data without changing `lastResult`, timestamps or event snapshots.

### Re-showing a prototype

`show_prototype` always carries a full spec; `patch_prototype` is the gated content/state/node contract (#11675).
When `spec.id` is the prototype already on screen and `reset` is absent or false,
the device replaces it in place: it keeps the display the prototype is on (the
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

## Lifecycle and safety

#12064 reverses the #9307 "non-removable dismiss control" default: chromeless
fullscreen is the default on a device advertising `prototype_window_chrome_v1`,
the bar is opt-in, and CtrlProxy's host escape is a stationary two-finger long
press for 1 s anywhere on the window that reveals a small dismiss pill for 5 s.
Recognition cancels authored touch handling and swallows the rest of that gesture.
A second hold restarts the pill's timeout; a replacing show hides it. A
host-owned wrapper exposes the `Dismiss AutoMobile prototype` accessibility
dismiss action without touch, and touch exploration (TalkBack) keeps the pill
permanently visible. Both the pill and the accessibility action dismiss with
reason `user` and remain usable at spec opacity 0. Back is not the exit: its
existing behavior is unchanged, dismissing only while a text field makes the
window focusable. Agent dismiss, a replacing show, authored dismiss, the
five-minute session idle TTL, last-client disconnect and service teardown keep
working. Home hides a session prototype when its app leaves the foreground.
A CtrlProxy that does not advertise `prototype_window_chrome_v1` keeps the bar,
and explicit `none` is refused by the host.

Two safety cases still need device verification: 3-button navigation with
`layer: "system"`, and a prototype shown with no application window in front
(which Home does not hide).

With `none`, authored content fills the full window including under the status
bar; top content needs top-edge `safeAreaPadding`, and relative sheet detents use
the full window height. With `bar` (including the older-device fallback), the
translucent host row remains above clipped authored content, independent of spec
style and opacity; its height is excluded from the authored viewport.
Both fullscreen modes keep the window alpha at 1 and fade only authored content
and its scrim, so the host dismiss control never inherits spec opacity.
A `persistence: "device"` prototype outlives its host session: it is not dismissed
when the last client disconnects (including a show queued after that edge), it
has no idle TTL, and its uploaded assets are kept until it is dismissed. Because
nobody may be connected to remove it, sheet and floating windows also carry an
opaque “Close” control drawn above the authored content, and spec opacity fades
only the content. Fullscreen defaults to `bar`; a device advertising
`prototype_window_chrome_v1` also honours explicit `none` with the hidden escape.
It ends through that control, the fullscreen dismiss row or revealed pill
(`user`), `dismiss_prototype` (`agent`), a replacing show, or service
unbind/destroy (`teardown`). Keyguard hiding is unchanged.

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

Every dismissal emits one `prototype_event` with `kind: "dismissed"`, null `name`,
and `payload: {"reason": "user|agent|disconnect|ttl|teardown"}` (one reason string).
Host and authored dismiss controls use `user`; `dismiss_prototype` uses `agent`;
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
changes and safety hide/restore do not. Hidden prototypes still expire. The current
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

### Foreground scoping (#10261, owner decision 2026-10-09)

A session prototype is tied to the app (package) it was shown over, matching the iOS
agent, which lives inside the app. When that app leaves the foreground the window is
hidden (state, pages and the idle TTL are kept; no `dismissed` event, no sequence
allocation) and when the app returns the same runtime is shown again. A
`window.persistence: "device"` prototype is a standalone mock and is not tied to an app.

- **Anchor.** Each `show` (including an in-place replace) reads the application
  window in front (the active application-type accessibility window, else the topmost)
  and clears any suspension. If no application window qualifies, the prototype is
  unscoped and stays up everywhere.
- **Signal.** `TYPE_WINDOW_STATE_CHANGED` events already delivered to CtrlProxy; no new
  poller. An event moves the foreground only when its window is `TYPE_APPLICATION`
  and its package is not CtrlProxy's own and not in the ignore set. IME, dialogs of
  type system, accessibility overlays (this prototype's own windows) and the shade
  are therefore never candidates. Ignore set: `com.android.systemui`,
  `com.google.android.permissioncontroller`, `com.android.permissioncontroller`,
  `com.google.android.packageinstaller`, `com.android.packageinstaller`, `android`
  (resolver, ANR and crash dialogs). A dialog of the same app is the same package.
  An event whose window type cannot be read is ignored (fails open: nothing hides).
- **Debounce.** A flip, either way, applies only after the new state holds for 400 ms
  (`PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS`), so a transient window does not flicker it.
- **Hidden means gone.** The window is removed, so it takes no touches and is absent
  from `observe`. `inspect` reports `suspended: true` on the prototype entry, and the
  hierarchy capture carries top-level `prototypeSuspended: true`, so `layer: "prototype"`
  calls fail with "hidden because the app it was shown over is not in front" instead
  of "no prototype is showing".
  `inspect` also reports optional `hiddenReason`: `app_layer_window_hidden` when the app in front hides an app-layer window, or `device_blocked` when locked or the screen is off. The host carries it into status and uses it for `prototype_hidden` layer refusals. A show reports `visible: false` with the same `notVisibleReason`; older devices retain `no_prototype_window_on_screen` for app-layer confirmation. Hidden reasons are absent when visible or suspended.

  The host stores `suspended` from `inspect` and surfaces it on `prototype` status
  entries (host-local, so it is as fresh as the last `inspect`; a new `show` or an
  `inspect` after the app returns clears it), and an `awaitEvent` that times out on
  a suspended prototype carries the same explanation as a `warning`. Absent on iOS.

- **Separate from other hides.** Suspension is its own state
  (`PrototypeForegroundTracker.suspended`). The host's `isBlocked` is the lock-screen
  check OR suspension, so any restore path (unlock, relayout, or a future capture-time
  hide from #9305) that calls `show` while suspended is refused; a capture restore
  can never re-show a suspended prototype, and ending suspension does not undo a
  capture hide held by another component.
- Dismissal, TTL expiry and teardown release the anchor. A hidden prototype still
  expires on its idle TTL.

Deferred: secure-window detection has no trusted existing signal.

### Bottom sheet and the keyboard (#10262)

Owner decision 2026-10-09: a bottom sheet moves above the keyboard whenever the keyboard
is shown and returns to the screen edge when it hides.

- **Scope.** Only a `sheet` window with `edge: "bottom"`. Fullscreen, floating, dialog,
  top and side sheet windows never move. A `bottomSheet` node lives inside its window
  and rides with it; it needs no separate handling.
- **Source.** The input-method window's bounds from the accessibility window list
  (`TYPE_INPUT_METHOD`), not the prototype window's `WindowInsets.Type.ime()`. Prototype
  windows are `TYPE_ACCESSIBILITY_OVERLAY` windows that are not the IME target, and the
  platform dispatches the IME inset only to the IME target, so a sheet over another app's
  field would read 0. The service sees the keyboard window whichever app owns the field.
  The lift is `screenBottom - ime.top` (0 when no input-method window has bounds).
  This follows from platform behaviour and is unit-tested with fake bounds; the API
  30/34/36 device check in the issue is still open.
- **Mechanism.** The host relayouts on the window events it already receives
  (`TYPE_WINDOWS_CHANGED`), setting the bottom-gravity window's `y` to the lift (a positive
  `y` raises a bottom-gravity window). Moving the window moves its touch region with it;
  touch-through and the foreground-suspension and capture hides are unchanged because
  they act on the same params and `isBlocked`.
- **No system panning.** A bottom sheet sets `SOFT_INPUT_ADJUST_NOTHING`, so a sheet that
  owns the focused text field is not also resized or panned by the platform.
- **Motion.** The position jumps. The accessibility source reports no per-frame values,
  so it cannot follow the keyboard's slide (`WindowInsetsAnimation` only reaches the IME
  target). `motion: "none"` therefore has nothing to disable here.
- **Explicit padding.** `safeAreaPadding` with `ime` still applies inside the window;
  on a lifted sheet it reads 0 for a non-IME-target window, so it does not double-count.

Device checks must cover keyguard timing, daemon death, pager page 3
across rotation, fold/display removal, and API 30/34/36 keyboard/cutout geometry.

This is Android only. The iOS agent does not lift a sheet above the keyboard, and whether to
rely on UIKit keyboard avoidance or match this behaviour is an open decision (see
[iOS prototype agent](../ios/prototype-agent.md#open-decisions)).

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

Both test suites enumerate the same `test/fixtures/prototype-spec/valid` and
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
