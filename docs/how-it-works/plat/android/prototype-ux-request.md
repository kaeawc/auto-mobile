# Prototype spec: request and share

Part of [the agent-authored prototype specification](prototype-ux.md).

## Request action (#12523)

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
progress in a state key. A prototype can then load and post real content with no agent round trip.
It requires `prototype_network_v1`, and `prototype_network_device_v1` as well when `via` is
`"device"`. Both are entries in `PROTOTYPE_SPEC_CAPABILITY_GATES` (the second gate's fields are only
the via-device requests). So show, patch and `replaceNode` refuse a spec containing one on a device
without them. A device advertising `prototype_network_v1` also writes `/data` for `into`, with the
`applyPrototypeDataWrite` semantics, without `prototype_data_actions_v1`.

| Field                  | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                  | Required, at most 2048 characters. Any absolute `http` or `https` URL. Host requests apply the egress policy described below. Takes the text placeholders of any text field: `{key}` (state), `{data:/pointer}`, `{item.field}`, `{index}`. Without a placeholder it must parse as an http(s) URL; with one, only the literal `http://` or `https://` prefix is checked, because the rest is known when the request runs. There is no `{state:key}` placeholder; use `{key}`.                                                                                                                                                                                                                                                                                                                                                                         |
| `method`               | `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE` or `HEAD`, the same `PROTOTYPE_REQUEST_METHODS` the host executor accepts. `body` is refused with `GET` and `HEAD`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `headers`, `query`     | Up to 16 entries each: a literal string (text placeholders apply) or a value binding `{state}`, `{data}`, `{value}`, and `{item}` / `{index: true}` in a repeat. A bound value must be a string, number or boolean. Header names must be HTTP tokens. Query entries are set on the URL in sorted key order (UTF-16 code units, like JS `sort()`), on every runtime, so the resolved URL does not depend on authoring order. With no authored `query` the URL's raw query is kept verbatim. Each authored key replaces the value at its first existing piece in place and removes later duplicates; new keys are appended in sorted order. Only those pieces are re-encoded (form encoding: space is `+`, `~` is `%7E`); untouched pieces keep their exact spelling (`?flag`, `%20`). E.g. `?a=1&b=x%20y&a=3&c` with `{a:"2"}` gives `?a=2&b=x%20y&c`. |
| `body`                 | A value binding, so a literal is `{value: json}`. Non-string values are sent as JSON with `Content-Type: application/json` unless a header sets one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `into`                 | `/data/<pointer>` with the data-action rules (whole `{index}` segment in a repeat). It must name an object member, not an array element, and its parent must exist. Optional: without it nothing is written to data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `statusKey`            | A declared **string** state key (a numeric or boolean key is refused). Set to `"loading"`, then `"success"` or `"error"`, so `visibleWhen` can show a spinner or an error. Inside a repeat it may hold placeholders like any state key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `via`                  | `"host"` (default) or `"device"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `timeoutMs`            | Optional integer, 1 to `MAX_PROTOTYPE_REQUEST_TIMEOUT_MS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `allowSecureInRequest` | Optional boolean. Lets this request send a `storage.secure` key; without it any reference to one is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
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
   (`message` `HTTP <status>`). The status decides this before the runtime consumes the body. The runtime never reads or caps a non-2xx body
   and reports it as `null`, so an oversized error page is `http_error`,
   not `too_large`. The size cap applies to 2xx bodies only. A transport failure is an error with the executor's code (`timeout`,
   `too_large`, `connection_refused`, `blocked_destination` (the destination is not permitted), `cancelled`, `invalid_url`, `invalid_request`, `network`,
   `too_many_in_flight`).
3. With `into`, the metadata is then written to **`<into>__meta`**: the same pointer with `__meta`
   appended to its last segment (`/data/feed` reports at `/data/feed__meta`; `prototypeRequestMetaPath`).
   Its value is `{status?: number, headers?: {name: value}, durationMs: number, error?: {code, message}}`.
   `status` and `headers` (lower-cased names) exist once a response arrived; `error` exists for every
   failure. If it does not fit the data write limit, the runtime drops `headers`. The completion is atomic.
   Suppose the body fits `/data` but no form of `__meta` fits beside it. Then `into` stays unchanged and the request
   is an error with `error.code` `invalid_response` (message `response and metadata exceed the data
   limit`). Its minimal metadata (duration and error) is still written if it fits, the status key
   becomes `error` and `onError` runs.
4. `statusKey` becomes `"success"` or `"error"`, the request event is sent, then `onSuccess` or
   `onError` runs.

**Event.** A finished request is an `emit` event with `name` `prototype_request` (reserved; an
authored `emit` with that name is a validation error). `prototypeRequestEventOf` (`prototypeRequestEvent.ts`) decodes its payload.
So the event adds no wire field and leaves
`ctrlProxyWireManifest.ts` unchanged:

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
abandonment). The host aborts that request's fetch, frees its in-flight slot and sends no reply, and the
device ignores a `prototype_response` that crosses it. The frame is not in the Kotlin-mirrored wire
manifest, like `prototype_request`. Beyond `MAX_PROTOTYPE_REQUESTS_IN_FLIGHT` a new request fails with
`too_many_in_flight`. Dismissing the prototype cancels its requests. `via: "device"` destinations are
checked as described in [Device destination policy](prototype-ux-patch.md#device-destination-policy).

**Android runtime (#12528).** CtrlProxy advertises both capabilities and runs the action in
`PrototypeRuntime`; the Kotlin twins of the TypeScript rules (`PrototypeRequest.kt`: resolver,
`PrototypeRequestOutcome`, event payload) are tested against the same fixture, `request-actions.json`.

- `statusKey` becomes `loading` in the tap's own interaction. The request then waits off the interaction on
  the controller's scope and completes under the controller's lock, so a response never lands mid-tap.
  Completion order is the contract's: `into`, `<into>__meta`, `statusKey`, the `prototype_request` event,
  then `onSuccess` / `onError`. A request that cannot start (unresolvable binding, in-flight cap) finishes
  at once as an error without a `loading` step.
- Both transports implement `PrototypeHttpClient`.
- With `via: "host"`, the runtime sends a `prototype_request` frame to the
  latest connected host over the CtrlProxy socket. It waits for the `prototype_response` with the same
  `requestId`. A silent host times out five seconds after the request's own timeout. With no host, the request fails at once
  with `network` naming `via: "host"`.
- With `via: "device"`, the transport is one Retrofit service (`PrototypeHttpService`)
  over an injected `OkHttpClient` with raw bodies and no converter, read with the
  `MAX_PROTOTYPE_RESPONSE_BYTES` cap. The contract timeout is the whole-call timeout.
- The two frames
  (`PrototypeNetworkFrames.kt`) stay outside the `WebSocketRequest` / `WebSocketResponse` hierarchies
  because the host reads them outside its Kotlin-mirrored wire manifest.
- CtrlProxy declares `android.permission.INTERNET` and a `network_security_config` with
  `cleartextTrafficPermitted="true"`, so http and https URLs both work. There is no allowlist of
  permitted hosts. The [device destination policy](prototype-ux-patch.md#device-destination-policy) refuses local and
  host-machine destinations instead.
- Saved prototypes (`SavedPrototypeActivity`) run `via: "device"` on the same client; `via: "host"` finishes
  as an `invalid_request` error because no host serves the activity.

The shared fixture `test/fixtures/prototype-spec/valid/request-actions.json` covers both `via` values,
`onSuccess` / `onError`, nesting, `statusKey` and `visibleWhen` on the status. A typical feed shows a
spinner with `visibleWhen: {key: "feedStatus", equals: "loading"}` and the failure with
`{data:/feed__meta/error/message}` under `equals: "error"`.

## Share contract

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
C0/C1 controls, NBSP, U+2028–U+202E, or U+2066–U+2069. This platform-neutral contract allows Windows reserved device names,
colons, trailing dots, and ordinary spaces. MIME values are nonempty RFC token `type/subtype` values, with no parameters.

The contract introduces no device-local media type. A complete `shareAssetIds` inventory enables static
unknown-ID refusal; bundle references use the existing asset lookup, and pure resolution always
checks the supplied uploaded inventory. Every referenced entry must include a nonnegative
safe-integer `bytes` value; malformed metadata fails with typed `invalid_args`. Existing asset transport limits and supported media types
still apply; the contract does not add PDF or other upload formats.

Contact fields are exactly `name` (nonblank, required), `phone`, `email`, `org`, `url`, `note`.
The pure `resolvePrototypeShare` twins produce vCard 3.0 (`text/x-vcard`, `public.vcard`):
`FN` and an unstructured family `N` hold name, with `TEL`, `EMAIL`, `ORG`, `URL`, `NOTE` in that
order. TEXT properties escape backslash, comma, semicolon and CR/LF. The URI-valued `URL`
property stays verbatim. Lines use CRLF, and lines fold at
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

### Known platform differences

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
