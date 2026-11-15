# Prototype spec: storage (#12522)

Part of [the agent-authored prototype specification](prototype-ux.md).

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
  that data actions and patch ops use. The validator refuses the whole document (`data:` alone), a
  pointer without a leading `/`, or an over-long pointer. It also refuses two data pointers where one is
  the other's ancestor or equal (`/cart` and `/cart/items`), so each stored value has one owner.
- Duplicate keys are refused.
- The values the spec itself holds for the listed keys, counted per entry as the UTF-8 bytes of the
  storage key plus the compact JSON of the value, must fit `MAX_PROTOTYPE_STORAGE_BYTES` (262144).

| Constant                      | Value  | Counting rule                                                                             |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `MAX_PROTOTYPE_STORAGE_BYTES` | 262144 | Stored bytes per prototype id: sum over stored entries of key bytes + compact JSON bytes. |
| `MAX_PROTOTYPE_STORAGE_KEYS`  | 64     | Entries in `storage.keys`.                                                                |

**What is stored.** After every write the device saves the listed keys under the spec `id`. A write
is a user write (a tap, a text edit), a device data action (`setData`, `appendData`, `prependData`,
`removeData`) or a `request` response (#12523) that writes state or data. A write that would take
the stored total over `MAX_PROTOTYPE_STORAGE_BYTES` still applies on screen. The device does not
store it, the previous stored value of that key stays, and the inspect report lists the key in
`skippedKeys`. Stored values are part
of the device's per-id state: they survive a dismiss, a process restart and a saved prototype's relaunch.

**Precedence (#12522).** The rules below are implemented once as the pure function
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
4. A stored value that no longer fits the spec is dropped, the spec's value stands, and the device
   deletes the dropped entry from storage. Such values are:
   - a `state` value whose type (string, finite number, boolean) differs from the spec's value;
   - a `state` key the spec no longer declares;
   - a `data` value of a different JSON kind than the spec's own value at that pointer (object,
     array, string, number, boolean);
   - a value `applyPrototypeDataWrite` refuses as a `set` (a missing parent, a data limit).
5. Restoring happens before the first draw and sends no `change` event; the show result and the
   host's cached state and data still describe the spec's values. Call `inspect` to read the live
   values.
6. **Host `patch` against a stored key.** The patch wins. It applies under the existing
   `baseRevision` conflict rules. A stored restore is not a device write, so it does not bump the
   revision or enter the write log. The device then stores the new value like any other write.

**Host tool support.**

- `inspect` reports what the device stores. The device reports, per prototype in its
  `inspect_prototypes` reply (and flat in the iOS agent's status), a `storage` object:
  `{version, keys: [{key, bytes}], totalBytes, skippedKeys?}` (`PrototypeStorageReport`). Its `keys`
  field lists only keys that currently hold a stored value, in storage-key form (`state:darkMode`,
  `data:/cart`). The host passes it through as `storage` on the prototype entry. It reports it absent
  when the device sends none (no `prototype_storage_v1`, or no `storage` block) or sends a malformed
  one. The `status` action shows the last inspected value and drops it after a successful
  `clearStorage`.
- `{action: "clearStorage", id}` wipes the stored values of `id`. The host sends
  `{type: "clear_prototype_storage", requestId, id}` (Android CtrlProxy; the iOS agent receives the
  same request type). The device answers one `prototype_result` with `success` and `cleared`, the
  number of keys removed (0 for an id with nothing stored). The action leaves the prototype on screen
  unchanged; the next show of the id starts from the spec's values. When the device does not
  advertise `prototype_storage_v1`, the host refuses the action before sending anything, with a
  message naming that capability.
- `deleteSaved` also clears the id's storage. This is device-side behavior and part of the contract:
  deleting a saved prototype removes its spec, assets, shortcut and stored values, so a later save of
  the same id starts clean. The `delete_saved_prototype` request needs no new flag. On iOS the saved prototype is
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
- **Show.** Restore runs before the device builds the runtime, so the first draw has the stored values;
  the runtime starts at the spec's revision and sends no `change`. The device deletes dropped entries at
  once. The restored spec must pass the same validation as a shown one (a stored text breaking
  `maxLength` would not), otherwise the device drops every stored value. A same-id show first flushes the shown prototype's pending write.
- **Write-back.** After each interaction and patch the session compares the listed keys with what it last
  saw and stores only those that changed, so an untouched key keeps following the spec. The first change of
  a burst arms one write `PROTOTYPE_STORAGE_DEBOUNCE_MILLIS` (500 ms) later; dismissal (any reason,
  including teardown), replacement and the saved activity's `onStop` flush at once. A failed write is
  logged and retried at the next flush. `request` responses are covered because they write through the same
  paths.
- **Limit.** Per id, the store sums entries against `MAX_PROTOTYPE_STORAGE_BYTES`. A write that would
  pass it applies live, but the store skips it: the key keeps its previous stored value and stays in
  `skippedKeys` until a later write fits.
- **Removed pointers.** A listed `data:` pointer removed by a data action loses its stored value (JSON
  `null` is not stored), so the spec's value returns on the next show.
- **Surfaces.** The overlay (`PrototypeController`), `persistence: "device"` prototypes and
  `SavedPrototypeActivity` all use it; a service prototype and the saved activity of the same id share one
  file (last write wins).
- **Host actions.** `clear_prototype_storage` clears the shown session (and its pending write) or, for an id
  nobody shows, the document. The prototype on screen keeps its live values. The
  `delete_saved_prototype` request clears the id's storage after deleting the saved copy.
- **Reinstall.** Stored values live in `filesDir`: they survive dismiss, process restart and a
  saved prototype's launch, not an uninstall, data clear or the reinstall fallback. The #12268 host mirror
  records saved prototypes from what the host sent at `save` and does not restore stored values.
