# Realtime channels

Part of [the agent-authored prototype specification](prototype-ux.md).

The strict root `channels` map declares up to four channel IDs (state-key grammar) and requires
`realtime` in `requires.platform`. Channel declarations, realtime calls and realtime state reads
require `prototype_platform_realtime_v1`. `via: "device"` additionally requires
`prototype_platform_realtime_device_v1`. Neither runtime advertises these capabilities.

A channel requires `kind: "websocket" | "sse"` and `url`. WebSocket URLs use ws/wss; SSE URLs
use http/https, sharing request URL placeholder and length rules. Optional `protocols` has up to
four unique WebSocket subprotocols, each an RFC 7230 token of 1..64 characters. The `headers` map has up to 16 entries and shares the request rules, also
refusing case-insensitive `Sec-WebSocket-*` and `Last-Event-ID`. Optional `via` defaults to host,
`connect` to onShow (or manual), `decode` to json (or text); `statusKey` names declared string
state. The `reconnect` object requires integer maxAttempts 0..20 and initialDelayMs/maxDelayMs with
100 <= initial <= max <= 60000.

Up to 16 ordered routes match `{pointer, equals}`, `{pointer, exists: boolean}`, an SSE event
name `{event}`, or every frame when `when` is absent. Routes allow state and data actions only;
requests, navigation and other effects are refused. Routes and onOpen/onClose/onError callbacks
have handler event scope: `{event: ""}` reads the whole event and a nonempty RFC 6901 pointer
reads a member. Root `platform.on` supports realtime.status and realtime.frame as well.
The `realtime.connect/disconnect` calls take a declared channel selector; `realtime.send` also takes a body
value binding and requires a WebSocket channel.

A selector is a literal string or `{value: id}`. Literal argument strings are nonempty and
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
source-to-target type checks for these two dynamic binding forms. The receiving runtime must
validate the resolved value before applying a write or call.

The realtime capability also gates `appendData.maxItems` and `upsertData {path, key, value,
maxItems?}` everywhere actions can occur. Upsert replaces the first matching identity in place
or appends; the incoming value must contain its valid, nonempty key pointer. A literal value is
refused statically when that pointer is missing or resolves to null. JSON identity uses
numeric value, exact strings and member names, and structural array/object equality. maxItems
is an integer 1..2000; oldest rows are dropped after replacement/append and before final data
limits. Missing/non-array targets and invalid writes leave input unchanged. The device runtimes run
an upsert from any action list through the shared writer and report it as a `change` event
`{op:"upsert",key,value?,maxItems?,revision}`, which the host replays the same way.

The daemon holds the upstream connection for `via: "host"` channels (see
[Host channel transport](#host-channel-transport)).

On Android, `PrototypeChannelController` (`prototype-compose`) is the per-prototype state machine
behind a `PrototypeChannelTransport`. The transport is OkHttp WebSocket/okhttp-sse from the device
(`prototype-saved`, same egress policy as device requests, no redirects followed, 25 s pings). For
`via: "host"` it is the CtrlProxy-socket relay, which fails an open at once with `network` when no
host is connected.
Transport callbacks pass through one ordered inbox, and every effect reaches its sink under one lock:
the `/platform/realtime/<channel>` snapshot, `realtime.status`/`realtime.frame` events, and route,
callback and `statusKey` actions to apply atomically. The first matching route wins (`{event}`
defaults to `message`); matched frames wait for the flush window and are coalesced. A frame that is
not JSON on a json channel, or larger than the frame cap, counts in `framesDropped`.

Status runs
idle → connecting → open, then reconnecting with backoff, ending closed (or error when the last
close carried one). Attempts reset after 5 s open. Sends wait in a 32-entry queue while
(re)connecting, flush on open and drop on close. A patch closes removed channels and reconnects only
changed live ones; dismiss closes every connection with 1001 and silences the sink. The controller is not
wired into the prototype runtime as the `realtime` module.

Pure TS, Kotlin and Swift rules replay shared
backoff and coalescing vectors under `test/fixtures/prototype-spec/realtime/`. Reconnect uses
full jitter: `floor(random * min(maxDelayMs, initialDelayMs * 2^(attempt-1)))`, with defaults of
8 attempts, 500 ms initial delay and 30000 ms maximum delay; exhausted attempts consume no
random value. Within one 50 ms flush window, consecutive frames made only of `setData` and
`setState` to the same set of targets collapse to the last frame. Appends and all other actions
remain ordered and are never coalesced. These are contract rules without runtime integration.

## Host channel transport

A `via: "host"` channel is a relay: the device sends `prototype_channel_open {connectionId,
prototypeId, channel, kind, url, protocols?, headers?, lastEventId?}` and the host answers with
`prototype_channel_opened`, one `prototype_channel_frame {data, event?, id?}` per upstream frame
and a final `prototype_channel_closed {code?, reason?, error?}`. The device sends
`prototype_channel_send {connectionId, data}` and `prototype_channel_close`. These are transport
messages outside the Kotlin-mirrored wire manifest; what a spec sees stays on
`prototype_platform_event`. The host never reconnects: the device state machine owns backoff, so
`via` does not change behaviour.

- **Egress.** The destination goes through the same pinning as requests. The host checks localhost names,
  every DNS answer and the daemon's own ports. The socket connects only to the validated address
  while keeping the URL's `Host` and TLS server name. A refusal is `blocked_destination`.
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

## Mock backend

A prototype can talk to a declarative backend with no server code (decisions in
`docs/devlog/2026-10-27-prototype-mock-backend.md`). A request whose URL host is
`<backendId>.mock.automobile.invalid` is answered in process by the daemon's backend of that id,
before the egress policy: no DNS lookup, socket or `adb reverse`. A host under that suffix that
names no defined backend fails as `network`. Backends live for the daemon session and are bounded
(16 backends, 16 collections, 64 routes, 64 rooms, 1 MiB of collections, routes, rooms and
broadcasts).

- **Collections** are json-server style. A `GET /<name>` request filters by `?field=value`, and
  `q` matches a case-insensitive substring of any string or number member. The `_sort=price|-price`
  parameter sorts stably (numbers numerically, strings by code point). The `_page` and `_limit`
  parameters page (default limit 10, at most 100) with an `x-total-count` header, and `after` and
  `size` cursor-page into `{items, next}`.
  Every defined item needs an id so a path and a cursor can both name it. The id is a number, or a
  non-empty string other than `.` and `..`, which URL normalization would turn into path navigation.
  The `GET /<name>/:id`, `POST` (201, id from the injected id generator when absent, 400 on an invalid id, 409 on a duplicate),
  `PATCH` (shallow merge), `PUT` (replace) and `DELETE` requests complete the surface. An item's id
  never changes, and a write that would exceed the size budget fails with 413 and changes nothing.
- **Routes** are canned responses `{method, path, status?, headers?, body?, delayMs?}` that win over
  collections. A path is literal segments and `:name` parameters. Bodies bind `{params.x}`,
  `{query.x}` and `{body:/pointer}`: a string that is exactly one placeholder takes the value's
  type, a placeholder inside text interpolates, and an unbound one is `null` or empty.
- **Latency and faults** draw from the backend's seeded random stream and wait on the injected
  timer, so a run replays identically. The `latencyMs {min, max}` setting delays every answer.
  Each fault `{path, method?, status, every | rate}` fires on every nth matching request or with probability
  `rate`, answering `{error: "mock fault"}`.
- **Rooms** serve `via: "host"` channels to the same origin (`wss://` for WebSocket, `https://` for
  SSE), with no socket. A connection joins the first room `{path, onConnect?, echo?, relay?,
  timeline?}` whose path pattern matches its URL path. With no match the answer is `handshake_failed` with
  status 404, and a room path with 64 connections refuses the next with 503. The room delivers
  `onConnect` frames right after `opened`. Each `timeline` entry fires `afterMs` after its own
  connection opened, on the injected timer. The `echo` flag returns a client send to its sender and `relay` passes it to the other
  connections of the same room path. Scripted frames bind `{params.x}` and `{query.x}` from the
  channel URL; a string frame goes on the wire as written and other JSON as JSON text. SSE
  connections only receive. Latency and faults apply to requests, not to channels.
- **Broadcasts** `{collection: {room, frame, on?}}` send a 2xx collection write (`POST` unless `on`
  lists `PUT` or `PATCH`) to the room path the binding produces. The `{item}` and `{item:/pointer}`
  bindings bind the stored item, so a message one device posts reaches every device in its room.
- Every answered request, client send, `publish` and broadcast is logged (latest 200, with one
  sequence number) for assertions; a frame entry is `{seq, room, from, data}`. Each connection
  joining or leaving a room is logged as `{seq, room, event}` with `event` `join` or `leave`; a
  leave covers a client close and a backend close.
- **Actors** (at most 16, each with 1–64 steps) write to collections and publish to rooms on the
  backend's injected timer. An actor with `on.route` (`"POST /path/:id"`) fires after a successful (status below 400)
  request matching it. Otherwise it runs `maxRuns` times every `every` ms (100 ms or more; run k
  starts at `afterMs + k * every`). Its steps run in order: `append`, `update` and `remove` go
  through the same collection code as `POST`, `PATCH` and `DELETE` (ids, 409, 413 and the size
  budget apply), and an actor write triggers its collection's broadcast like a request would. A
  `publish {room, frame}` step sends a frame to a room path, logged with `from: "publish"`. Each
  step's `afterMs` is relative to the previous step, and `value`, `id`, `room` and `frame` bind the
  triggering request's placeholders.
- Actor limits: the backend logs and skips a failing step. A backend holds at most 256 scheduled
  steps; a trigger past that is dropped and logged. Redefining, clearing or ending the session
  cancels every pending step. Definition refuses `advance` and `notify` until mock polylines and
  simulated push exist. Actors follow the daemon's timer, not the device
  clock that `prototype simulate` advances.

The `prototype` tool drives it with host-local actions that make no device request:

- `defineBackend {backendId, backend}` validates the definition and replaces the backend of that id
  (a failed definition leaves the old one).
- `clearBackend {backendId}` removes it.
- `publish {backendId, room, frame}` delivers a frame to every connection in a room path and
  reports `delivered`.
- `backendLog {backendId, since?}` returns the log.

Replacing or clearing a backend, and session end, close its open channels with code 1001. These
actions' results report the origin a spec should call. The `show` action takes `mock`
(`{backendId: definition}`) or `mockPath` (an absolute file of the same, read like `specPath`, up to
2 MiB). After the spec passes validation, every entry is validated and defined or none is,
replacing backends of the same id. A saved prototype does not carry its mock backends. A request
that carries a `timeoutMs` is bounded by it like any host request. A request that times out or is
cancelled while waiting on latency never writes to the backend.
