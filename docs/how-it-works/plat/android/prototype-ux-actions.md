# Prototype spec: actions and state

Part of [the agent-authored prototype specification](prototype-ux.md).

| Action `type` | Properties                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emit`        | Required nonempty `name`; optional `context` of named bindings (see Emit context below); optional arbitrary JSON `payload` up to the 4 KiB conservative compact JSON budget (null and nested JSON allowed). |
| `setPage`     | Required existing `pager` ID; required `page`: `next`, `prev`, or nonnegative integer index up to 2147483647. Renderer clamps to available pages.                                                           |
| `setState`    | Required state `key` and scalar `value`; creates or replaces a key.                                                                                                                                         |
| `toggle`      | Required `key` that the spec's `state` declares as a boolean; flips it.                                                                                                                                     |
| `increment`   | Required `key` that `state` declares as a finite number; adds optional finite `by` (default 1, negative values decrement). Non-finite results are ignored.                                                  |
| `decrement`   | Same as `increment` but subtracts `by` (default 1); `decrement` with a negative `by` adds. Non-finite results are ignored.                                                                                  |
| `dismiss`     | No additional properties.                                                                                                                                                                                   |

## Emit context

Use a stable `emit.name` such as `pick` and `context: {id: {item: "id"}}` to report a
repeat item's id, instead of encoding the id into the event name. The `emit.payload` stays literal
and uninterpolated. The device resolves context when the emit action runs, after earlier
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

A show or patch replacement using `emit.context` requires `prototype_emit_context_v1`; the host
refuses older devices before upload, display or patch dispatch. The `prototype_event` wire has `context` next to the unchanged
`payload` only if the emit declared context (including an empty object). It has
`contextTruncated: true` only when truncated; otherwise the field is omitted, never false.
`awaitEvent` and host status preserve these fields.

No scripts, callbacks, expressions or implicit navigation. `setState` must preserve a text-field, selection
or sheet binding's scalar type at runtime (renderer-enforced, #9300).

## Data actions (#12519)

`setData {path, value}`, `appendData {path, value}`, `prependData {path, value}` and `removeData {path}` let a tap change `/data`
on the device, so "add to cart" or "delete row" needs no agent round trip. They require
`prototype_data_actions_v1` with `prototype_data_model_v1`; prepend also requires
`prototype_lazy_list_v1`. The
host refuses a show, or a patch whose resulting spec contains one, on a device without it. It uses
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
  storage restores (#12522). The `set` op creates or replaces an object member or replaces an existing array
  element. The `append` op pushes one row onto an existing array. The `prepend` op inserts an ordered array at
  the start and trims from the end under maxItems. The `remove` op deletes an existing member or element and
  shifts later elements down. Errors are typed (`invalid_path`, `invalid_value`, `not_found`,
  `not_array`, `limit_exceeded`) and change nothing. The data after a write must satisfy the data
  depth and array limits and `MAX_PROTOTYPE_DATA_WRITE_BYTES`.
- The validator checks pointer syntax and `{index}` placement and rejects a literal value data cannot
  hold. When the target has no `{index}` and resolves in the spec's own `data`, it also rejects an
  `appendData` or `prependData` whose target is not an array. A target created only by an earlier write is the device's
  to check.

Each device write is reported on a `change` event, using existing wire fields so no event field is
added:

- `name` is the written `/data/...` path (for an append, the array);
- `payload` is `{op: "set"|"append"|"extend"|"prepend"|"remove", value?, maxItems?, revision}`;
- `validity` may accompany it.

A `change` whose name is a data path must carry a valid payload or the host drops it. The
`awaitEvent` tool returns it like any other event.

Android: `PrototypeRuntime.writeData` (over the shared `PrototypeDataWriter`, a mirror of
`applyPrototypeDataWrite`) applies a write to an immutable copy of `/data` and Compose re-renders `repeat`
and `{data: ...}` bindings. A refused write (typed error, unresolvable value binding, rows the renderer
cannot take) changes and emits nothing, is logged, and the rest of the list still runs. Each accepted write
takes its own revision. The event carries the value only while the payload fits
`MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES`; otherwise it is left out and the host stops tracking the spec. With no
host connected, a device-persistent prototype's write events wait in `PrototypeOfflineEventBuffer`.

**Revisions and host patches.** The device has one revision counter per prototype, shared with iOS
(#13040). Every `show` takes the next revision: the first show of an id is revision 1, a re-show
moves it on, and none rewinds it. Both platforms replay
`test/fixtures/prototype-spec/revision/show-revisions.json` to pin it. A data write bumps
it and reports the new value as `payload.revision`; a patch result's `revision` is the same counter.
The agent's `/data` patch and a device write must not silently lose each other, so:

1. The host applies every reported write to its tracked copy of the spec and to `status` data with
   `applyPrototypeDataWrite`, keeping the copy exact. Sometimes it cannot: the value did not travel,
   the copy disagrees, or a show is in flight so the order is unknown. It then stops tracking the
   spec and removes the reported data; the next patch requires a show first.
2. It also logs `{path, revision}` of each write (the last 64 per prototype, remembering the newest
   revision it forgot). A show of that id clears the log.
3. Until the device has written a prototype's data, `/data` patches behave as before. After that, a
   patch with a `/data` op requires `baseRevision`. The host refuses it before sending when a write
   newer than `baseRevision` touched a path that overlaps an op path (equal, ancestor or
   descendant), or when `baseRevision` is older than the forgotten writes. The refusal uses the
   existing `conflict` shape plus the touched paths (`conflict: {revision, state: {}, data: [paths]}`). A device receiving a
   `/data` patch applies the same rule against its own history. `replaceNode` and `/state` ops are
   unaffected.

A device write bumps the device revision and is reported in the change event; a stale `baseRevision` gets
the existing conflict. Host bookkeeping lives in `PrototypeShownSpecs` (`recordDeviceDataWrite`,
`dataPatchGuard`), called from `InMemoryPrototypeStatusStore.recordEvent` and `performPrototypePatch`.
