# iOS prototype agent: data, storage and network

Part of [the iOS simulator prototype agent](prototype-agent.md).

## Strings and semantics capability

`prototype_strings_v1` supports string tables, plural `{t:key|count}` references and show `locale`;
`prototype_semantics_v1` supports node heading, liveRegion, group, label, hint and traits.
See [Strings and semantics](../android/prototype-ux-lists-strings.md#strings-and-semantics-14210) for resolution,
plural rules and platform mappings. iOS observe snapshots do not expose SwiftUI traits.

## Data model capability

Advertises `prototype_data_model_v1` for the shared
[data model contract](../android/prototype-ux-envelope.md#data-model-11673); the host refuses data-model shows on
an agent without it, before uploads or show. Core resolves bindings once per show: path repeats become
projected literal items, text placeholders scalar text, data conditions constants.

Decode order:

1. Guard data.
2. Refuse non-object authored children.
3. Apply two independent node budgets and the depth limit. Ordinary
   nodes and nonempty literal-repeat instances use the expanded budget. Path-bound, empty or malformed
   templates use the authored-template budget once.
4. Guard `MAX_PROTOTYPE_REPEAT_PATH_CELLS` in container pre-order.
5. Check substituted text against the per-field
   limit and the 4,194,304 UTF-16 rebuilt-text total per show. Inside a repeat, the decoder charges a data-resolved field
   once per item even without repeat placeholders. It does not charge literal fields and state placeholders.
6. Refuse nested repeats unless the renderer advertises `prototype_nested_repeat_v1`; see the
   [repeat contract](../android/prototype-ux-envelope.md#data-model-11673).
7. Resolve with projected items cached per pointer.
8. Guard the resolved tree.
9. Expand repeats.

The decoder clamps state placeholders to the shared UTF-16 substituted-text limit. State
interpolation then uses the ordinary expanded tree. The decoder accepts `repeat.key`, but rows keep positional
identity until keyed patching (#11675).

Data is agent-owned and read-only except via the data actions; inspect/status report it with state. Two
data keys that are canonically equivalent Unicode strings collapse on iOS (Swift dictionary keys compare
by canonical equivalence), unlike host and Android. The agent re-checks data depth/array limits in the
host's traversal order; the strict boundary also enforces the host data byte-cost rule.

## Data actions capability

Advertises `prototype_data_actions_v1` for `setData`, `appendData`, `prependData`, `removeData`
([contract](../android/prototype-ux-actions.md#data-actions-12519)). The `PrototypeRepeat` type binds a whole `{index}`
path segment and `{item}`/`{index}` values per row at expansion, so row actions arrive concrete.
The `PrototypeSession` type resolves `{value}`/`{state}`/`{data}` and applies `PrototypeDataWrite` (twin of the
host's `applyPrototypeDataWrite`: codes `invalid_path`, `invalid_value`, `not_found`, `not_array`,
`limit_exceeded`; `MAX_PROTOTYPE_DATA_WRITE_BYTES`). It then rebuilds the tree from the authored root with
`PrototypeSpec.replacingData`, so data text, repeat rows and conditions refresh. The session refuses a write when it
can't rebuild the tree for it within show limits.

The shared prepend contract uses `prependData {path,value}` (one resolved row) and writer/event
`{op:"prepend",value:[row],maxItems?,revision}` at the written array path. It needs lazy-list,
data-actions and data-model capabilities. Rows retain input order at the front; the smallest
matching list cap trims from the end before final limits. Malformed pages/caps are dropped.
Renderers retain the first visible row key and offset across writes, including at the top
(headers/footers excluded); a trimmed key uses the renderer default. Stack entries preserve and
restore list anchors across push/pop, falling back to the nearest surviving index or top when the
row is gone. Prepend, anchoring and per-stack-entry list scroll restore are not device-verified
until the acceptance run.

A refused write changes and emits nothing and does not stop the rest of the action list. An accepted
write bumps the id's data revision. The revision is monotonic per id, and re-show never rewinds it. Every show is one
revision, so the first reports 1 as on Android (#13040). The write also emits one `change` event named by the
written `/data/...` path (the array for an append) with payload `{op, value?, revision}`. Extend/prepend values may be absent when over the emit byte budget, which abandons the host mirror. The counter is shared with `prototype_patch_v1` (#11675): device state writes and
accepted patches take the next revision too.

## Storage capability

Advertises `prototype_storage_v1` and the `clear_prototype_storage` request (#12526;
[contract](../android/prototype-ux-storage.md)). Values live in the host app's sandbox at
`Application Support/AutoMobilePrototypeAgent/storage/<id>.json` (`FilePrototypeStorageStore`), never in
the app's files or `UserDefaults`; the viewer app uses the same code in its own sandbox. Writes are
atomic and the id is percent-encoded into the file name. A file that doesn't decode (or is far over the
byte limit) is logged, deleted and treated as empty.

`PrototypeStorageCoordinator` is the only code touching a `PrototypeStorageStore`.
The `PrototypeModel.show` method calls `prepare` first. There `PrototypeStorageRestore` (twin of the host's
`restorePrototypeStorage`) applies precedence and deletes entries that no longer fit. It hands restored
state/data to `PrototypeSession.show(_:restoredState:)` before first draw (no `change` event, no data
revision bump). After each transition `sessionChanged` writes moved listed keys on a trailing 400 ms
debounce (injected `PrototypeClock`); dismissal, next show, `get_prototype_status` and app
background/end flush immediately. A write that would exceed `MAX_PROTOTYPE_STORAGE_BYTES` still applies
live, keeps the previous stored value and is listed in `skippedKeys`. A `reset: true` show does not clear
storage.

`get_prototype_status` (and standalone `inspect_prototypes`) carries
`storage: {version, keys: [{key, bytes}], totalBytes, skippedKeys?}` when the spec declares `storage`.
`clear_prototype_storage {id}` answers `cleared` (count of keys removed) and leaves the shown prototype.
The iOS saved prototype is its own app, so `deleteSaved` uninstalls it and its sandbox.

## Request action capability

Advertises `prototype_network_v1` and `prototype_network_device_v1` for `request`
([contract](../android/prototype-ux-request.md#request-action-12523)). The `PrototypeSession` type twins the host's
`applyPrototypeRequestOutcome`. A tap resolves bindings against committed state/data
(`PrototypeRequestResolver`, twin of `resolvePrototypeRequest`). It binds `{key}` and `{data:/pointer}` in
one pass, so it never rescans substituted values. The tap then moves `statusKey` to `loading` and issues a start
command. Later, `completeRequest` writes `into`, then `<into>__meta` (dropping `headers` if over the data
write limit), moves the status key, emits the `prototype_request` event and runs `onSuccess`/`onError`
in that order. An unbuildable request (unresolvable binding, invalid URL) or a refused one
(`too_many_in_flight` at 4) completes at once as an error. A newer request to the same `into` cancels
the older: it writes nothing, leaves the status key, runs no follow-up and reports `cancelled`
(`durationMs` 0, the session has no clock). Dismissal, a replacing show of another prototype and `reset`
cancel all; a same-id replace keeps them.

`PrototypeRequestValidator` repeats the host's static rules at show: URL scheme, method, bodies on
GET/HEAD, and `into` naming an object member. It also checks `statusKey` naming a declared string state key, header names,
entry counts, `timeoutMs` 1..30000, follow-up lists 1..32, the reserved `prototype_request` emit name and
`MAX_PROTOTYPE_ACTION_DEPTH`. The `PrototypeRepeat` type binds `url`, `statusKey`, `into`, header/query strings,
binding objects and nested follow-up lists per row.

Every runtime sets query entries in sorted key order (UTF-16
code units, like JS `sort()`), so the resolved URL and event `url` match the host. The Swift decoder holds `query` unordered,
so the rule is canonical. The runtime edits the query on raw
`&`-separated pieces: a set key replaces its first piece in place (later duplicates removed), new keys
append, untouched pieces keep spelling (`flag`, `%20`). A string body without an author `Content-Type`
is `text/plain; charset=utf-8`; other JSON bodies `application/json`.

`PrototypeRequestDriver` runs what the session starts behind a clock and two seams (deterministic
tests):

- **`via: "host"` (default).** A `prototype_request` frame (`prototypeRequestMessageSchema`) goes to
  exactly one connection, the most recently authenticated (`PrototypeConnectionRegistry.current`, as
  Android's `WebSocketServer.sendToHost`), so a reconnecting daemon replaces its predecessor and a
  side-effecting call never runs twice (events still broadcast). Each pending call remembers its owning
  connection (`PrototypeHostRouting`); when it closes its calls end as `network` even if an older
  connection remains. The host's `prototype_response` arrives as an ordinary request line routed to the
  driver, never replied to. When the device drops a host call (superseded, dismissed, reset, timed out),
  it sends `{"type":"prototype_request_cancel","requestId"}` to the owner (skipped if gone). The host
  aborts the fetch, frees its slot, sends no reply and ignores a late response. A silent host ends as
  `timeout` after `timeoutMs` + 2 s; no connected host, or the last leaving, ends as `network`. Host side:
  `createPrototypeRequestHost` wired via `attachIosPrototypeRequests`, which also cancels the device's
  requests on connection close.
- **`via: "device"`.** Core owns the `PrototypeHttpClient` protocol and links no HTTP library. The agent
  injects `PrototypeURLSessionClient`, built on a dedicated ephemeral `URLSession` (never `.shared`, so app
  cookies, cache and credentials stay untouched). It applies the contract's 30 s ceiling and treats `timeoutMs` as a total
  deadline. It stops reading a 2xx body and fails `too_large` past 262144 bytes, or when `Content-Length`
  announces more. It never reads a non-2xx body, so that is `http_error` however large. It maps URLSession
  errors to contract codes and reports duration from task metrics. Tests run it over a `URLProtocol` stub.

The package has no HTTP library dependency; another client would be a second `PrototypeHttpClient`
conformance chosen where the agent builds the driver, with no Core change.

**App Transport Security.** See [Data, storage and network](#data-storage-and-network-12531).

## Data, storage and network (#12531)

iOS view of the data/storage/request features; the shared contract and capability map are in the
Android doc, [Data, storage and network](../android/prototype-ux-data-network.md#data-storage-and-network-12531).

| Capability                    | Gates                                                                | iOS agent                                                      |
| ----------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `prototype_data_actions_v1`   | `setData`, `appendData`, `prependData`, `removeData`                 | [Data actions capability](#data-actions-capability)            |
| `prototype_storage_v1`        | root `storage` block, `inspect` `storage`, `clear_prototype_storage` | Sandbox `Application Support/AutoMobilePrototypeAgent/storage` |
| `prototype_network_v1`        | `request` with `via: "host"`                                         | [Request action capability](#request-action-capability)        |
| `prototype_network_device_v1` | `request` with `via: "device"`                                       | Dedicated ephemeral `URLSession`                               |

### Destination policy (#13815)

`PrototypeEgressPolicy` checks `via: "device"` requests before starting, against every DNS
answer, and at each redirect. It refuses:

- `localhost` and `*.localhost`;
- loopback (`127.0.0.0/8`, `[::1]`),
  unspecified, link-local and multicast addresses and Android emulator host aliases;
- names with no DNS
  answer or any refused answer, and ambiguous numeric spellings;
- the daemon's HTTP ports (3000-3010, 8765)
  on private addresses.

Other private (RFC1918) and public addresses are permitted. A refusal completes as
`blocked_destination`. Neither transport has an allowlist.

**`localhost` on a simulator.** The simulator shares the Mac's network stack, but `localhost`,
`127.0.0.1` and `[::1]` are refused for both `via` values (this policy; and the host's own egress policy
for `via: "host"`, see the Android doc's [host egress policy](../android/prototype-ux-data-network.md#data-storage-and-network-12531)).
To reach a Mac service, bind it to a non-loopback interface and use the LAN address on a non-daemon port
(e.g. `http://192.168.1.10:8080/feed`). Nothing is reversed on iOS (Android uses `adb reverse`).

**App Transport Security.** Device requests (`via: "device"`) are subject to the app's ATS. IP-literal `http://` hosts are
exempt (as is `localhost`, which the policy refuses first). ATS blocks any other cleartext host
(`NSURLErrorAppTransportSecurityRequiresSecureConnection`). The request then completes as a typed `network` error
telling the author to use `via: "host"` (which runs without ATS) or `https://`. The viewer template sets
`NSAllowsArbitraryLoads` in `Viewer/Info.plist`, so a viewer runs any URL.

**Storage precedence** as Android: a changed `version` discards stored values, stored values replace
the spec's for listed keys, values that no longer fit are dropped. A failed disk write keeps keys dirty
and retries; a same-id re-show restores from the unsaved values meanwhile.

**Limits** (same as Android):

| Limit                                        | Value                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/data` write (after any action or response) | `MAX_PROTOTYPE_DATA_WRITE_BYTES`, 1048576 bytes of data cost                                 |
| Response body                                | `MAX_PROTOTYPE_RESPONSE_BYTES`, 262144 bytes, 2xx only                                       |
| Request `timeoutMs`                          | 1 to 30000, default 10000                                                                    |
| Requests in flight                           | 4 per device                                                                                 |
| Header and query entries                     | 16 each, values up to 4096 characters                                                        |
| Storage                                      | at most 64 keys, 262144 stored bytes per prototype id                                        |
| Emit payload                                 | 4096 bytes; a larger `change` event drops its `value` and the host stops mirroring that spec |
