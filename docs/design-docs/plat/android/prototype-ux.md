# Agent-authored prototype specification

Current, unversioned contract for the agent-authored prototype (#9296, child of #9295). Android Compose
rendering, asset transport, the wire messages, the `prototype` MCP tool and the
[iOS simulator agent](../ios/prototype-agent.md) implement it; the iOS
[feature support table](../ios/prototype-agent.md#feature-support) lists what is Android only (`display`,
`window.layer: "app"`, `window.persistence: "device"`, `inspect`, idle TTL). A spec accepts no code,
expressions, URLs, image bytes or migration instructions.

## Owner decisions

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
| `motion`  | Optional `none`, `standard` (default), or `reduced` for alpha-only scroll motion. See Motion below.                    |
| `storage` | Optional `{version, keys}` naming state keys and `/data` pointers the device keeps across shows. See Storage (#12522). |
| `root`    | Required single node.                                                                                                  |

All numeric values are finite. State keys (including action/binding/condition
keys) match `[A-Za-z_][A-Za-z0-9_]{0,63}`. No nested state, arrays, or nulls.
Prototype IDs, pager IDs, tags, event names, and asset IDs are opaque nonempty
strings; they do not share the state-key restriction.

| Constant                             | Value           | Counting rule                                                                                      |
| ------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------- |
| `MAX_PROTOTYPE_NODES`                | 2000            | Includes root and every child/page/sheet child; `repeat` templates count once per instance.        |
| `MAX_PROTOTYPE_DEPTH`                | 24              | Root has depth 1; only node nesting counts.                                                        |
| `MAX_PROTOTYPE_IMAGES`               | 32              | Counts image nodes and nav item image uses, including hidden ones; repeated asset IDs count again. |
| `MAX_PROTOTYPE_SPEC_BYTES`           | 1048576 (1 MiB) | UTF-8 bytes of raw JSON, including whitespace.                                                     |
| `MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES` | 16              | Maximum named bindings per emit.context.                                                           |
| `MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES`   | 4096 (4 KiB)    | Conservative compact JSON byte budget for each emit payload; numbers reserve 32 bytes.             |

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

Limits (`schemas/prototype-spec-contract.json`): `MAX_PROTOTYPE_DATA_BYTES` 262144,
`MAX_PROTOTYPE_DATA_DEPTH` 8 (data is depth 1; only containers add depth), `MAX_PROTOTYPE_DATA_ARRAY_ITEMS`
500, `MAX_PROTOTYPE_DATA_POINTER_LENGTH` 256 UTF-16 units. Byte cost reuses the emit payload cost (32 bytes
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
- A condition uses exactly one of `key`, `data`, `all`, `any`, `not` (see Conditions). A `key` or `data` form
  takes exactly one comparison: `equals` (same scalar type and value; numbers by value, -0 equals 0),
  `notEquals` (its inverse, including missing or non-scalar), `gt` or `lt` (numbers only, otherwise false).
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
| Condition `.key`                                                                          | `Exactly one of key, data, all, any, not is required`                                                                                                                 |
| Condition comparison field                                                                | `Requires key or data or platform`; `Exactly one of equals, notEquals, gt, lt, empty is required`                                                                     |
| Condition `.equals` / `.notEquals` in bindable visiting order                             | `Repeat placeholder in a data condition operand is not supported`                                                                                                     |
| `<node>.repeat`                                                                           | Existing expanded node/image limit errors                                                                                                                             |

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
without `visibleWhen`, or when motion is off.

A style `pressScale` (0.5–1) shrinks a tappable node while it is pressed. With
motion on it animates with a short spring; with `motion: "none"` or animator
scale 0 it snaps, so a screenshot taken mid-press is still deterministic.

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

### Stack transitions

`prototype_stack_transitions_v1` gates every explicit stack `transition` and push/replace
`transition` override. Omission means `platform`; pop/popToRoot have no override. The contract
is validated by both agents, and both advertise the capability.

| Value      | Platform behaviour                         |
| ---------- | ------------------------------------------ |
| `platform` | Native navigation animation (default).     |
| `slide`    | Directional screen slide, reversed on pop. |
| `fade`     | Screen crossfade.                          |
| `none`     | Instant screen change.                     |

Android slides enter from the end edge with 30% outgoing parallax, mirrored in RTL; pop and
popToRoot reverse that direction. Platform replace crossfades. Animations finish within 300 ms.
`motion: "none"` and animator duration scale 0 snap immediately. The reduced-motion composition
hook changes slides to crossfades; system preference wiring is deferred to #15115.

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

- **Animated style.** A node's `animate: {durationMs?, easing?}` (0–2000 ms, default 300;
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

`setData {path, value}`, `appendData {path, value}` and `removeData {path}` let a tap change `/data`
on the device, so "add to cart" or "delete row" needs no agent round trip. They require
`prototype_data_actions_v1` (which a device advertises only with `prototype_data_model_v1`); the
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
  element; `append` pushes onto an existing array; `remove` deletes an existing member or element and
  shifts later elements down. Errors are typed (`invalid_path`, `invalid_value`, `not_found`,
  `not_array`, `limit_exceeded`) and change nothing. The data after a write must satisfy the data
  depth and array limits and `MAX_PROTOTYPE_DATA_WRITE_BYTES`.
- The validator checks pointer syntax and `{index}` placement, rejects a literal value data cannot
  hold, and, when the target has no `{index}` and resolves in the spec's own `data`, rejects an
  `appendData` whose target is not an array. A target created only by an earlier write is the device's
  to check.

Each device write is reported on a `change` event, using existing wire fields so no event field is
added: `name` is the written `/data/...` path (for an append, the array) and `payload` is
`{op: "set"|"append"|"remove", value?, revision}`. `validity` may accompany it; a `change` whose name
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
write (a tap, a text edit), a device data action (`setData`, `appendData`, `removeData`) or a `request`
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

**Capabilities.** `prototype_platform_v1` gates `requires`, `platform.on`, the `platform` action and
`{platform}` reads; each module adds `prototype_platform_<module>_v1`, and a later op or event gets
a `_v2` gate that checks the fields that version introduced. The gates are generated from
`platformModules` and join `PROTOTYPE_SPEC_CAPABILITY_GATES`, so show, patch and `replaceNode`
refuse uniformly. Because every module use must be declared in the root `requires`, which a patch
cannot add, a patch never introduces a module the shown spec did not already require.

The shared fixtures `test/fixtures/prototype-spec/valid/platform-*.json` and
`invalid/platform-*.json` are replayed by the TypeScript, Kotlin and Swift validators.

### Conditions

A condition is exactly one of these forms. `visibleWhen` takes any of them;
`bottomSheet.openWhen` keeps the boolean `{key, equals}` form.

| Form                       | Holds when                                                               |
| -------------------------- | ------------------------------------------------------------------------ |
| `{key, equals: scalar}`    | The state value is exactly equal (same type). A missing key never holds. |
| `{key, notEquals: scalar}` | The state value differs, including when the key is missing.              |
| `{key, gt: number}`        | The state value is a number greater than `gt`. Any other type is false.  |
| `{key, lt: number}`        | The state value is a number less than `lt`. Any other type is false.     |
| `{data \| platform, ...}`  | The same comparisons on a `/data` or `/platform` value (see above).      |
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

## Data, storage and network (#12531)

The three features compose: a `request` writes its response into `/data`, data actions edit `/data`
from a tap, and `storage` makes chosen `state` and `/data` values survive a re-show or relaunch.
The detailed contracts are [Data actions](#data-actions-12519), [Storage](#storage-12522) and
[Request action](#request-action-12523); this section is the one-page overview and the capability
map.

| Capability                    | Gates                                                     | Android CtrlProxy | iOS agent  |
| ----------------------------- | --------------------------------------------------------- | ----------------- | ---------- |
| `prototype_data_actions_v1`   | `setData`, `appendData`, `removeData`                     | Advertised        | Advertised |
| `prototype_storage_v1`        | root `storage` block, `inspect` `storage`, `clearStorage` | Advertised        | Advertised |
| `prototype_network_v1`        | the `request` action with `via: "host"`                   | Advertised        | Advertised |
| `prototype_network_device_v1` | `request` with `via: "device"`                            | Advertised        | Advertised |

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
| `/data` write (after any action or response) | `MAX_PROTOTYPE_DATA_WRITE_BYTES`, 262144 bytes of data cost                                  |
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
chromeless escape pill keeps its text. Session-scoped sheets and floating windows still draw no host control
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

## Accessibility lint (#14126)

A successful `show` or `patch` returns `accessibilityFindings`: an advisory, host-only lint of the
component-expanded spec sent to the device. It never refuses a show and needs no device capability.
Each finding names a `rule`, the node `path` and a `detail`. The output keeps 50 findings, and
`accessibilityFindingsTotal` reports the full count when it is capped.

| Rule                   | Finds                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlabeled-control`    | A node with `onTap`, `onLongPress` or `onDoubleTap`, or an `iconButton`, `fab`, `switch`, `checkbox`, `slider` or `select`, with no `contentDescription`, `label`, `text`, `spans`, `headline` or `title` on itself or a descendant.                                                                                                                                  |
| `unlabeled-image`      | An `image` or `icon` with a `testTag` but no `contentDescription`. An untagged, non-tappable one without a description is decorative: the renderers hide it from accessibility, so it is not reported.                                                                                                                                                                |
| `unlabeled-text-field` | A `textField` or `searchBar` with no `label`, `placeholder` or `contentDescription`.                                                                                                                                                                                                                                                                                  |
| `low-contrast`         | A `text` node with an authored `style.color` below WCAG AA against the nearest background the host can resolve: 4.5:1, or 3:1 for large text (`textSize` 24 or more, 18.66 or more at `fontWeight` 700, or a `display`/`headline` `textStyle`). It is checked in light and dark, or only the mode `theme.mode` pins; `mode` names the failing one, `value` the ratio. |
| `small-touch-target`   | A tappable node or control whose authored `width`, `height`, `maxWidth` or `maxHeight` is under 48dp (44pt on iOS); `value` is the smallest side. Sizes left to layout are not checked.                                                                                                                                                                               |

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

The on-device audit of a shown prototype and the RTL check that #14126 also proposes are not
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
screen are absent from `observe`; `swipeOn lookFor` still finds them. The iOS agent does not
advertise the capability yet (#14671), so the host refuses these specs there.

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

## Charts (#14209, not device-verified)

A `chart` node draws a `line`, `area`, `bar` or `ring` chart from 1 to 4 `series`. Each series
reads the `/data` array at `path` (objects only, at most 500 like any data array), taking each
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
`setState profileHandle {match: "text"}` then `push profile`. `{match}` anywhere else is refused, as
are repeat bindings inside `onTap`. A URL tap never opens a browser; that is the `links.open`
platform call. Matches are links like tappable spans (Android `tapOn {accessibilityLink}`, iOS
`tapAt`) and require `prototype_linkify_v1`.

Owed device checks (later platform passes): advertise the capability only after renderer support;
verify mixed span styles, resolved concatenated observe text, per-span actions without URL navigation,
Android semanticLinks and both selectors across windows, and iOS tapAt-only links plus platformNotes.
The shared contract caps spans at 64 per text node. Host tests do not verify device rendering.

## Menu and select

`menu` and `select` require `prototype_menus_v1`; the host refuses them before showing or uploading assets when the connected renderer lacks it.

A `menu` requires `openWhen: {key, equals}` with a boolean equality and 1–16 strict `items`. Each item is `{label, icon?, trailingText?, enabled?, onTap?}` or exactly `{type:"divider"}`. Labels and trailing text are nonempty, icons use the existing icon names, and `onTap` has 1–32 existing actions. A disabled item is dimmed, cannot be tapped and does not close the menu. Dividers are neither focusable nor tappable. The elevated surface is anchored to its parent’s bottom end and clamped inside the window. An enabled item or outside tap writes `!equals` to the open key; item actions run after closing.

While a menu is open, the page behind it is removed from the accessibility tree, like a dialog; the menu items and outside-dismiss layer remain exposed. Closing restores the page. An expanded select leaves the page in the accessibility tree.

A `select` requires a string `stateKey` and 2–32 `{value,label}` options with unique nonempty values and nonempty labels; its optional label is nonempty. It shows the current option’s label, or empty text when no option matches, and a trailing expand indicator. Expansion is local view state. Choosing an option writes the string key, emits the same `change` payload as `radioGroup`, and collapses the list. Tapping the field again or outside also collapses it. Both nodes support repeat templates and reusable `use` components: state keys, menu item labels/trailing text/actions and select labels/option labels bind placeholders.

Rendering stays inside the prototype window on both platforms so `observe` and `tapOn` reach the normal hierarchy. Android uses an in-window surface rather than a separate DropdownMenu/Popup window. iOS uses an in-window list rather than system SwiftUI Menu/Picker popups; successful iOS shows report this substitution in `platformNotes`. Menu icons use the existing SF Symbols mapping on iOS.

The select field and menu surface carry the node `testTag`. Select option rows use `<testTag>.<value>`; menu item rows use `<testTag>.<index>`, with zero-based positions including dividers. Android adds row tags only when `testTag` is set; iOS falls back to `(testTag ?? id).<value>` or `(testTag ?? id).<index>`.

## Checks

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

### Timers

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
