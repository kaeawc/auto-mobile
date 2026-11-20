# Prototype spec: envelope and data model

Part of [the agent-authored prototype specification](prototype-ux.md).

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

There is no `specVersion`: an older or newer envelope shape is rejected, never migrated. Every object
is strict: unknown properties, unknown node or action types, explicit `null` for an optional field and
wrong types reject the whole spec with a path.

All numeric values are finite. State keys (including action/binding/condition
keys) match `[A-Za-z_][A-Za-z0-9_]{0,63}`. No nested state, arrays, or nulls.
Prototype IDs, pager IDs, tags, event names, and asset IDs are opaque nonempty
strings; they do not share the state-key restriction.

| Constant                             | Value           | Counting rule                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_PROTOTYPE_NODES`                | 2000            | Per stack screen: the screen's subtree plus everything drawn with it (content outside the stack, a nested stack's largest screen); sibling screens never add up. Without a stack, the whole tree. `repeat` templates count once per instance, except lazy `list` row templates, which count once (including when empty); list headers/footers count once. |
| `MAX_PROTOTYPE_SPEC_NODES`           | 10000           | Nodes across the whole spec, every stack screen included (5x `MAX_PROTOTYPE_NODES`).                                                                                                                                                                                                                                                                      |
| `MAX_PROTOTYPE_LIST_ITEMS`           | 2000            | Maximum rows per lazy list, read from its data path; ordinary path repeats remain capped at 128.                                                                                                                                                                                                                                                          |
| `MAX_PROTOTYPE_DEPTH`                | 24              | Root has depth 1; only node nesting counts.                                                                                                                                                                                                                                                                                                               |
| `MAX_PROTOTYPE_IMAGES`               | 32              | Per stack screen, counted like `MAX_PROTOTYPE_NODES`. Counts image nodes and nav item image uses, including hidden ones; repeated asset IDs count again; lazy list row templates, headers and footers count once.                                                                                                                                         |
| `MAX_PROTOTYPE_SPEC_IMAGES`          | 160             | Image uses across the whole spec, every stack screen included (5x `MAX_PROTOTYPE_IMAGES`).                                                                                                                                                                                                                                                                |
| `MAX_PROTOTYPE_SPEC_BYTES`           | 1048576 (1 MiB) | UTF-8 bytes of raw JSON, including whitespace.                                                                                                                                                                                                                                                                                                            |
| `MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES` | 16              | Maximum named bindings per emit.context.                                                                                                                                                                                                                                                                                                                  |
| `MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES`   | 4096 (4 KiB)    | Conservative compact JSON byte budget for each emit payload; numbers reserve 32 bytes.                                                                                                                                                                                                                                                                    |

Feed-scale budgets (#14183). Lazy-list rows live in `/data`, so `MAX_PROTOTYPE_DATA_ARRAY_ITEMS` never sits
below `MAX_PROTOTYPE_LIST_ITEMS`, and `list.maxItems` shares the list cap. Data may use
`MAX_PROTOTYPE_DATA_BYTES` (786432) of the spec. That stays below `MAX_PROTOTYPE_SPEC_BYTES` so the node
tree keeps room. The write cap `MAX_PROTOTYPE_DATA_WRITE_BYTES` equals it: later host patches re-validate the whole spec
against the data cap, so a write cap above it would let paging grow data that no patch could survive. The
response cap (256 KiB) stays below both.

The byte, node, depth, image, storage and in-flight limits
are independent of row count: they bound frame size, memory and tree cost, and none of them grows with lazy
rows. A row carries at most `MAX_PROTOTYPE_REPEAT_PATH_CELLS` / `MAX_PROTOTYPE_LIST_ITEMS` (32) scalar fields
across a full list. Host validation is linear in rows (`benchmark/prototype-feed-limits.ts`). Feeds beyond these caps page or trim with `maxItems`; per-runtime
budgets and multi-spec apps are not part of the contract.

Stack-screen budgets (#14213). Renderers draw only a stack's top screen, so node and image bounds
apply per screen rather than to every screen at once. The `MAX_PROTOTYPE_SPEC_NODES` /
`MAX_PROTOTYPE_SPEC_IMAGES` (5x one screen) bound validation and wire cost for the whole spec. The
rule is static and identical in the host, Kotlin and Swift validators: a push cannot be refused on
the device, so no runtime "active path" is counted. Two stacks drawn side by side add their largest
screens. A screen over its bound fails at the crossing node with `Node limit exceeded` or `Image
limit exceeded`; the whole-spec ceiling fails with `Spec node limit exceeded` or `Spec image limit
exceeded` (`Expanded …` inside `repeat`). The other whole-spec budgets (effects, keyframe nodes,
loops, video nodes) still count every screen.

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
decode; Kotlin uses kotlinx.serialization sealed hierarchies. The functions `validatePrototypeSpec` /
`PrototypeSpecValidator.validate` are the complete entry points (structure, limits and cross-references
precede typed decode); never bypass them with a model decoder. Untagged dimension, detent, page-target and
scalar unions have explicit Kotlin serializers; only arbitrary emit payloads keep `JsonElement`. Validated
integer fields normalize decimal/exponent spellings before Kotlin decoding (`100.0` and `1e2` both mean
100). The protocol module has no API-dump task; its artifact includes the contract resource.

### Advertised spec schema

The Zod spec converts to a JSON Schema of about 56k tokens, almost all of the `prototype` tool
definition. The `tools/list` response therefore advertises a terse `spec`: the top-level fields with their JSON types,
the required list, `additionalProperties: false` and the root node type names. It has no `$ref` or
`$defs`, because strict clients reject references in tool input schemas. The full schema is the
`automobile:prototype/spec-schema` resource (a standalone draft-07 document whose recursive `$ref`s point
at its own root), built on first read. Setting `AUTOMOBILE_PROTOTYPE_FULL_SCHEMA=1` inlines that schema in `spec`
instead, with its references rebased to `#/properties/spec`.

The proxy reads the flag for its cold list
built from `schemas/tool-definitions.json`. It sends `true` on its connection presentation profile
(`__autoMobilePrototypeFullSchema` on the profile's `setToolEnabled` write). The daemon then inlines the
schema in that connection's `tools/list` even when the daemon process itself runs without the flag. The
daemon's own flag sets the default for every connection; a client cannot opt a flagged daemon back to
the terse form, because the proxy forwards only `true` and absence means no preference. Either way the server
validates with `validatePrototypeSpec`, so the advertised form never changes what is accepted.
The `publish` `frame` is checked with `z.json()` but advertised as `{}`, because `z.json()` converts to a
recursive `$defs` pair.

## Data model (#11673)

The `data` field is an optional top-level plain JSON object, agent-owned and read-only on the device (objects, arrays,
strings, finite numbers, booleans; no null; arbitrary object keys). The `state` field stays the user-owned scalar map.
The `setState`, `toggle`, `increment` and `decrement` actions target only declared state keys, including per-row keys. A
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
  state-key, action and expanded node/image checks still run. Templates may nest one container repeat with a `{field}` source and `prototype_nested_repeat_v1`;
  the source resolves against each outer item, with at most 100 object rows per item. Inner bindings
  include both aliases, `{index}` (inner) and `{outerIndex}` (outer). Expanded budgets charge every pair.
  A third level and pagers are invalid.
- `MAX_PROTOTYPE_REPEAT_PATH_CELLS` bounds the sum across path-bound repeats in pre-order after component
  expansion (empty templates included): each instantiated object item costs its projected scalar members, or
  one if none; literal repeats are free. After the three path-source checks, exceeding it fails at
  `<node>.repeat.items.path` with `Repeat path cell limit exceeded`, before projection. Cell counts and
  projected lists are cached by pointer within a validation call.
- `MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH` (16384 UTF-16 units) bounds the sum of replacement lengths per
  bindable field at each substitution stage. The stages are data in text-kind fields, then repeat in every bindable field
  per item, including repeat placeholders inserted by data. The limit does not count literal characters, unresolved repeat
  placeholders or state placeholders (state changes after show).
  The `MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL` limit (4194304 units) bounds rebuilt text per validation. Each recognised
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
  takes exactly one comparison: `equals`, `notEquals`, `gt`, `lt` or data-only `empty`. With `equals` the
  operands match in scalar type and value (numbers by value, -0 equals 0). The `notEquals` comparison is its
  inverse, including missing or non-scalar. The `gt` and `lt` comparisons take numbers only, otherwise false. State-key forms additionally accept `contains`, `startsWith`, `lengthGt` or `lengthLt`.
  Data `equals`/`notEquals` operands are literals; a repeat placeholder there is rejected (state operands
  still bind). `bottomSheet.openWhen` keeps its boolean `{key, equals}` form. Component props are never
  bound in `repeat.items.path` or a condition's `data`; `repeat.key` passes through expansion unchanged.

The host validates data and repeat paths and sends authored bindings unchanged. The device resolves them
before repeat expansion: it projects path items, binds text and turns conditions into in-memory constants. All
data-model uses (top-level data, path items, `repeat.key`, data conditions, recognised text placeholders)
require `prototype_data_model_v1`. The host refuses an older device before any upload or show. The refusal names the
first usage field (data first, then node fields in document order, depth-first) and counts the others. It carries
an update/relaunch hint and a literal-content fallback. The `status` result reports a deep copy of the last successful
show's data next to state. The `inspect` result reports and adopts device data, dismiss clears it, and status
omits absent data. Events never carry data.

Android: CtrlProxy keeps the original validated spec for state-write validation, persistence, replay and
status. Both render entry points (`mapPrototypeSpec` and the runtime's incremental mapper) resolve the
authored spec. The runtime caches the resolved root per (root, data) identity pair and the resolved spec per
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
