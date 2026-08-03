# Client Screen Control: third-party client guide

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

Milestone 28 (Client Screen Control), parent
[#1099](https://github.com/kaeawc/auto-mobile/issues/1099). This is the **single entry
point** for building a screen-control surface against the AutoMobile daemon. Screen control
lets a client that mirrors a device screen turn pointer and keyboard input on the mirror into
real device input — a click becomes a tap, a drag becomes a swipe, a keystroke becomes text or a
device key.

The contract is deliberately published rather than kept as private UI detail, because the
**desktop app is not the only consumer**: any client that speaks the daemon's Unix-socket
`input/*` protocol can implement the same control surface. Everything a third-party author needs
is on this page or in the documents it links; **you do not need to read any Compose or
Kotlin source to implement a correct client.** The desktop app is a consumer, but it is not yet a
conforming `frameContext` reference implementation.

## What talks to the daemon (and what does not)

| Consumer | Uses screen control? |
| --- | --- |
| Desktop app (`android/desktop-app`) | **Yes** — legacy frame-context integration; see [#4596](https://github.com/kaeawc/auto-mobile/issues/4596). |
| Third-party daemon clients | **Yes** — the audience for this document. |
| IntelliJ / Android Studio plugin (`android/ide-plugin`) | **No — inspector only.** |

The IDE plugin shares the `desktop-core` rendering code but **never enables control mode**. It
is an inspector: it selects elements and highlights them, and forwards no device input of any
kind. Control mode is opt-in and default-off, so a host that does not enable it gets exactly
today's inspector behavior with no source change. Read the absence of control in the IDE plugin
as a deliberate scope decision, not a dropped feature.

## The five contracts

Screen control is five separate contracts. This page ties them together; each linked document is
the normative spec for its piece.

| # | Contract | Where it lives |
| --- | --- | --- |
| 1 | The `input/*` socket endpoints (tap, swipe, pressButton, typeText, key) | [Unix Socket API → Input API](unix-socket-api.md#input-api) |
| 2 | Viewport→device **coordinate mapping** ([#3346](https://github.com/kaeawc/auto-mobile/issues/3346)) | [Screen Control Mapping](screen-control-mapping.md#viewport--device-mapping) |
| 3 | **Drag-to-swipe** threshold and cancellation ([#3350](https://github.com/kaeawc/auto-mobile/issues/3350)) | [Screen Control Mapping → Drag-to-swipe policy](screen-control-mapping.md#drag-to-swipe-policy) |
| 4 | **Key-forwarding** and host-shortcut policy ([#3351](https://github.com/kaeawc/auto-mobile/issues/3351)) | [Screen Control Mapping → Keyboard forwarding policy](screen-control-mapping.md#keyboard-forwarding-policy) |
| 5 | **Frame snapshot** pairing + **post-input refresh** ([#3348](https://github.com/kaeawc/auto-mobile/issues/3348)) | [Client Frame Snapshot](client-frame-snapshot.md) |

## Observation stream protocol

The frame snapshot in step 1 is assembled from the daemon's **observation stream**, a separate Unix
socket from the request/response `input/*` API. This is the wire contract a client needs to connect;
it is authoritative to `src/daemon/deviceDataStreamSocketServer.ts`.

### Socket and framing

- **Path:** `~/.auto-mobile/observation-stream.sock` (`$HOME/.auto-mobile/observation-stream.sock`).
- **Framing:** newline-delimited JSON. Each request and each pushed message is a single JSON object
  on its own line (`\n`-terminated). There is no length prefix.

### Subscribe handshake

Send a `subscribe` command; the daemon replies once, then pushes update messages until you
`unsubscribe` or disconnect.

```json
// client -> daemon
{ "id": "1", "command": "subscribe", "deviceId": "emulator-5554" }
// daemon -> client
{ "id": "1", "type": "subscription_response", "success": true }
```

- `deviceId` is **optional**: omit it (or send `null`) to receive frames for **all** devices; pass a
  specific id to receive only that device's frames. A control client should subscribe to the one
  device the user selected.
- Optional `screenshotIntervalMs` / `hierarchyIntervalMs` on the `subscribe` request set the capture
  cadence (daemon defaults: screenshot 3000 ms, hierarchy 1000 ms; minimum 250 ms). To change
  cadence in place later, send `{ "command": "update_cadence", "screenshotIntervalMs": …,
  "hierarchyIntervalMs": … }`; to stop, send `{ "command": "unsubscribe" }`. An older daemon that
  does not know a command replies with a benign error and keeps its default cadence.

### Keepalive (ping/pong) — required to stay connected

The daemon actively reaps subscribers it considers dead. Every **10 s** a keepalive sweep sends
each subscriber a ping push and destroys any subscriber whose activity has not been refreshed for
**more than 30 s**, removing its subscription. Because reaping happens only on those 10 s sweep
boundaries, the effective disconnect lands **between just over 30 s and just under 40 s** of
inactivity, depending on how the subscription aligns with the sweep. A client that subscribes but
never answers pings is disconnected in that window — even while it is happily receiving frames.

```json
// daemon -> client, every 10 s
{ "type": "ping", "timestamp": 1737942000789 }
// client -> daemon, in reply
{ "command": "pong" }
```

- Reply to each `ping` with `{ "command": "pong" }` on the same connection (newline-terminated,
  like every request). No `id` is needed, and the daemon sends **no response** to a pong — it only
  refreshes your subscription's activity timestamp.
- The ping's `timestamp` is the daemon's clock in epoch milliseconds; it is informational.
- **Receiving pushed frames does not count as activity.** The daemon deliberately does not refresh
  liveness on its own successful outbound writes — otherwise the frame stream itself would keep a
  hung client "alive" forever. A client that consumes `screenshot_update`s but never pongs is
  reaped by the first sweep after 30 s of inactivity. Liveness is refreshed by your `pong`, the
  initial `subscribe`, and one narrow exception below.
- **The one exception — backpressure `drain` — is not something to rely on.** If a push overflows
  the daemon-side socket buffer (the write crosses the high-water mark), the daemon listens for the
  socket's `drain` event, and that drain — proof the peer actually read the backlog — refreshes the
  activity timestamp. A slow reader that repeatedly triggers backpressure can therefore incidentally
  survive past 30 s without ponging. Do **not** design a client around this: a healthy reader never
  fills the buffer, so no drain events fire, and only pongs keep it alive.
- Simplest compliant implementation: on any received line with `"type": "ping"`, immediately write
  `{"command":"pong"}\n`. There is no harm in an unsolicited pong; an unknown command, by contrast,
  gets an `error` response.

### Pushed messages

Every push carries a `type`, the `deviceId` it belongs to, and a display-only `timestamp`. Pair
frames **only** across messages with the same `deviceId`.

**`hierarchy_update`** — the element tree. Carries a `captureSequence` and, on current
CtrlProxy runners, a device-authored `frameContext`.

```json
{
  "type": "hierarchy_update",
  "deviceId": "emulator-5554",
  "timestamp": 1737942000123,
  "data": { "hierarchy": { "…": "ViewHierarchyResult with element bounds" } },
  "hierarchyDiff": { "…": "optional per-frame diff summary" },
  "captureSequence": 42,
  "frameContext": "android-generation-42",
  "coordinateSpace": "px",
  "nativeScale": 1
}
```

**`screenshot_update`** — the pixels. Carries a `captureSequence` **only when** the daemon verified
that the frame's real pixel dimensions match the geometry its capture client claimed; otherwise the
field is **absent** and a control client must fail closed for that frame.

```json
{
  "type": "screenshot_update",
  "deviceId": "emulator-5554",
  "timestamp": 1737942000456,
  "screenshotBase64": "<PNG bytes, base64>",
  "screenWidth": 1080,
  "screenHeight": 2340,
  "captureSequence": 42,
  "frameContext": "android-generation-42",
  "coordinateSpace": "px",
  "nativeScale": 1
}
```

**`error`** — a device-side problem (e.g. connection lost):
`{ "type": "error", "deviceId": "…", "timestamp": …, "error": "device connection lost" }`.

(The stream also pushes `navigation_update`, `performance_update`, and `storage_update`; a control
client ignores them.)

### Coordinates: one unit, no platform knowledge required

Both messages declare the unit of their geometry with `coordinateSpace`. `"px"` means **canonical
physical pixels** in the current device orientation — the element `bounds`, the
`screenWidth`/`screenHeight`, and the screenshot's own pixels are all that one unit, on **both**
platforms. That is the whole contract:

- **Reading.** Take `bounds` and `screenWidth`/`screenHeight` as pixels. A controllable px frame
  also carries a matching finite, positive `nativeScale` on both messages. Nothing else to convert
  or look up, and no platform branch is needed. Because both sides are the same unit, the frame's
  dimensions and the mapping bounds are comparable **exactly** — see the geometry rule in
  [Client Frame Snapshot](client-frame-snapshot.md#coordinate-space-canonical-pixels).
- **Writing.** Send `input/tap` and `input/swipe` coordinates in those same pixels. The daemon does
  any runner-specific conversion itself (it divides by the runner-reported `nativeScale` for the iOS
  XCUITest runner, exactly and without rounding; Android runners already take pixels).
- **Do not outlive the declaration.** That conversion uses the runner's *current* metadata, so a
  coordinate mapped against a frame whose space has since changed would be converted as the wrong
  unit. Bind the declared space to the snapshot and stop acting through a **retained** frame the
  moment an incoming message declares a different one — see
  [Client Frame Snapshot](client-frame-snapshot.md#coordinate-space-canonical-pixels).

The daemon stamps `"px"` only when the runner supplied complete scale metadata
([#4548](https://github.com/kaeawc/auto-mobile/issues/4548),
[#4549](https://github.com/kaeawc/auto-mobile/issues/4549)).

**Legacy fallback — when the field is absent.** An older runner supplies no scale metadata, so the
daemon leaves its geometry alone and stamps nothing. In that state iOS `bounds` are logical points
while the screenshot is pixels, and `input/*` coordinates are passed through untouched (the client
was already working in points). A client in this state must:

- **not** assume pixels — an absent field is not a `"px"` field;
- **not** compare the frame's absolute dimensions against the mapping bounds — compare aspect ratios
  with a tolerance instead;
- otherwise behave identically. The mapping formulas in
  [Screen Control Mapping](screen-control-mapping.md#viewport--device-mapping) are ratio-based and
  work unchanged in either space.

A simple client may support only the `"px"` path and treat a frame with no `coordinateSpace` as
unavailable for control; that fails closed, which is always safe.

**An unrecognized value is not the legacy fallback.** If a message declares a `coordinateSpace` this
client does not implement — some future value — you **must** treat that frame as **unsupported** and
fail closed, not fold it into the absent/point-space path. The two states carry different amounts of
knowledge: *absent* means "a daemon whose geometry and `input/*` units I know exactly", while
*declared something else* means "a daemon newer than me, whose bounds I cannot interpret and whose
input endpoints may expect a unit I do not know". Degrading the second into the first would forward
coordinates whose meaning is unknown, to real hardware. Surface it as a version mismatch — the
reference client blocks with a distinct `UnsupportedCoordinateSpace` reason and tells the user to
update — rather than as a transient condition that will resolve itself. Keeping the two distinct is
also what lets the retained-frame rule below notice a transition *into* an unknown space.

### Pairing and the active device

- **Pair on both identities, never on `timestamp`.** A screenshot and a hierarchy describe the
  same captured device state only when their `captureSequence` values are **equal** and
  `screenshot.frameContext == hierarchy.frameContext`, with both values non-null. `timestamp` is
  display-only and mixes two clocks (a hierarchy's is the device wall clock, a screenshot's is the
  daemon's), so it must not gate pairing. `captureSequence` is monotonic and never reset for the
  daemon process lifetime, so an id cannot be reused across a device reconnect. A
  `screenshot_update` with no `captureSequence` or with a missing/mismatched `frameContext` cannot
  be paired — fail closed. The full rationale and the rest of the availability rules are in
  [Client Frame Snapshot](client-frame-snapshot.md).
- **Legacy runners:** a runner that does not publish `frameContext` cannot produce a controllable
  snapshot. Keep its mirror in inspector mode rather than omitting `frameContext` from an input
  request and guessing. The optional field remains compatible with generic, non-screen-control
  socket clients that do not have an observation snapshot.
- **Release availability:** the default `0.0.50` CtrlProxy artifacts predate `frameContext`
  support. Use runners built from a revision that publishes the field before enabling this control
  flow; otherwise treat the runner as legacy and keep the mirror in inspector mode.
- **Active device:** every message's `deviceId` identifies its device. Subscribe with the selected
  device's id (rather than the all-devices `null`) so you only receive its frames, and still confirm
  each message's `deviceId` matches the selection before pairing — a lingering frame from a
  previously-selected device must not pair with the new one.

## Implementing a client, end to end

This is the protocol contract for a third-party screen-control client. The bundled desktop client
does not yet implement `frameContext` pairing or echoing, so it is not a conforming reference for
this flow; its integration is tracked in [#4596](https://github.com/kaeawc/auto-mobile/issues/4596).
Treat its current control behavior as legacy.

A control client is a loop: assemble a frame, map an input against it, forward it, wait for the
picture to catch up. Do these in order.

### 1. Subscribe and assemble a frame snapshot

Subscribe to the daemon observation stream (wire protocol below:
[Observation stream protocol](#observation-stream-protocol)) and consume `screenshot_update` and
`hierarchy_update` messages. **Do not** act on either message alone. Assemble an immutable
[frame snapshot](client-frame-snapshot.md#the-snapshot) that binds together, for one device:

- the displayed pixels and their real dimensions,
- the element hierarchy with its `bounds`,
- the shared **capture identity** — a screenshot and a hierarchy belong to the same snapshot only
  when `screenshot.captureSequence == hierarchy.captureSequence`,
- the device **frame identity** — `screenshot.frameContext == hierarchy.frameContext`, with both
  values non-null.
- the declared **coordinate space** of both messages, which decides whether the snapshot's geometry
  check is the exact one or the legacy aspect-only one, and, for `"px"`, their matching finite
  positive `nativeScale`
  ([Coordinates](#coordinates-one-unit-no-platform-knowledge-required)).

Control is available **only when a snapshot exists**. If any
[availability rule](client-frame-snapshot.md#availability-rules) fails — no device selected, stream
disconnected, screenshot older than 5 s, screenshot and hierarchy capture identities disagree, no
`captureSequence` stamped at all, or missing/mismatched `frameContext` — the client must **fail
closed** to inspector behavior and forward nothing. There is no partial control state.

This is the load-bearing safety rule of the whole feature: mapping a click through a stale or
mismatched frame taps the wrong pixel on real hardware. Pairing is **identity, never elapsed
time** — see [Pairing is identity](client-frame-snapshot.md#pairing-is-identity-never-elapsed-time).

### 2. Map a pointer point to a device coordinate

When the user clicks the mirror, map the viewport pixel to a device coordinate with the formulas
in [Viewport → device mapping](screen-control-mapping.md#viewport--device-mapping). The device
coordinate space is the snapshot's `deviceWidth`/`deviceHeight`, **not** whatever your view last
rendered, and its unit is whatever the frame declared — canonical pixels for a `"px"` frame. Key
rules:

- A single width-based ratio scales both axes (the frame is aspect-fitted).
- The mapping **never clamps**; it returns the raw coordinate plus an `inBounds` flag.
- A control client **must not tap an out-of-bounds point** — drop it. (An out-of-bounds *drag
  end* is the one exception; see below.)

Map the point through **exactly the snapshot the user clicked**, and keep that snapshot bound to
the input all the way to the request. A snapshot swap between click and send must not change the
mapping or the target device.

### 3. Decide what the gesture actually is

Not every pointer or key event becomes input. These are **client-side** policies — the daemon
executes whatever it is handed, so convergence on one policy is what keeps clients consistent.

- **Tap** — an in-bounds click → one [`input/tap`](unix-socket-api.md#inputtap) at the mapped
  coordinate.
- **Drag → swipe** — a drag is a swipe only if it travels far enough to be deliberate:
  **≥ `24 * nativeScale` device coordinates** on a `coordinateSpace: "px"` frame, **≥ 24** on a
  legacy one (the threshold preserves the same physical distance in each frame's unit; see
  [Drag-to-swipe policy](screen-control-mapping.md#threshold)), measured after the end is
  clamped. Below that, send **nothing** — not a swipe and *not* a tap. Map both
  endpoints through the **one** snapshot pinned when the drag began. A drag that *started*
  off-screen is dropped; a drag that *ended* off-screen is clamped to the last addressable pixel.
  Use a fixed **300 ms** duration, not the pointer velocity. Full rules:
  [Drag-to-swipe policy](screen-control-mapping.md#drag-to-swipe-policy).
- **Keyboard** — forward only while the mirror view **holds keyboard focus** and is in control
  mode. A keystroke carrying **Ctrl/Alt/Meta** belongs to the host and is not forwarded (with one
  documented AltGr/Option composition exception). `Escape` → `input/pressButton back`;
  Enter/Tab/Backspace/Delete/arrows (unshifted) → [`input/key`](unix-socket-api.md#inputkey); a
  printable ASCII character → [`input/typeText`](unix-socket-api.md#inputtypetext) with
  `mode: "append"`. A declined keystroke must be left **unconsumed** so it reaches the host's own
  shortcuts. Full rules:
  [Keyboard forwarding policy](screen-control-mapping.md#keyboard-forwarding-policy).

### 4. Forward over the socket

Send the corresponding `input/*` request, with the coordinate exactly as the mapping produced it —
no unit conversion, on either platform. See
[Copy-paste raw socket examples](unix-socket-api.md#copy-paste-raw-socket-examples) for
one-liners you can pipe straight into the socket. The device id must come from the snapshot the
input was mapped through, never from a device selection resolved at send time. Echo that exact
opaque `frameContext` on every request (`input/tap`, `input/swipe`, `input/pressButton`,
`input/typeText`, and `input/key`); do not generate it, substitute a newer value, or carry it
across a reconnect.

The echo gives every endpoint the daemon's latest-observation freshness check. `input/tap` and
`input/swipe` additionally carry the token to CtrlProxy for device-boundary validation. Text,
button, and key input do not yet have that final runner check, so a transition between the last
hierarchy update and execution can still pass the daemon gate; do not describe those endpoints as
having the gesture guarantee. Android's remaining device-boundary work is tracked in
[#4586](https://github.com/kaeawc/auto-mobile/issues/4586).

Forward all inputs through **one ordered, bounded queue** so a tap-then-swipe-then-type sequence
reaches the device in the order the user made it. If the queue is full (a stalled daemon), surface
an overload error rather than dropping silently.

### 5. Refresh from the stream, do not poll

The `input/*` responses return the action result only; they do **not** carry a fresh observation
and do **not** trigger one. After a successful input, **consume the next superseding snapshot from
the stream you are already subscribed to — do not poll and do not issue a separate `observe`
call.** Hold the pre-input snapshot on screen (still clickable) until a snapshot with a strictly
greater capture identity arrives, or a 3 s timeout releases it. A failed or ignored input changes
nothing on the device, so it clears nothing. Full state machine:
[Post-input refresh policy](client-frame-snapshot.md#post-input-refresh-policy).

A stale-context rejection means the device changed after the client assembled its snapshot. Surface
the daemon error, keep the displayed snapshot intact, and wait for a newly paired snapshot before
allowing an intentional retry. Do not retry the original request automatically: its coordinates and
the user's intended target may no longer describe the current screen.

## User feedback

A client should give the user clear, non-noisy feedback:

- **Success** — a brief transient indicator that an input was forwarded (the reference client
  pulses a marker where a tap landed) plus the eventual stream refresh. Keep it transient.
- **Failure** — surface the daemon's actionable error (e.g. an iOS `input/key` rejection, or an
  older device that cannot type an uppercase character) through a dismissible banner.
- **Blocked** — when control is unavailable, optionally explain why (device disconnected, frame
  stale, capture identity unavailable). Debounce it so transient blips during normal streaming do
  not flicker.

None of this is required by the daemon; it is client UX guidance so control surfaces feel
consistent.

## Android vs iOS support matrix

| Input | Android | iOS |
| --- | --- | --- |
| Tap (`input/tap`) | ✅ Supported | ✅ Supported |
| Swipe / drag (`input/swipe`) | ✅ Supported | ✅ Supported |
| Device buttons (`input/pressButton`) | ✅ Supported | ⚠️ Supported with platform gaps (unsupported buttons fail rather than being ignored) |
| Discrete keys (`input/key`: Enter, Tab, arrows, …) | ✅ Supported | ❌ Unsupported — CtrlProxy exposes no discrete key events; the daemon returns an actionable error |
| Printable text (`input/typeText`) | ✅ Supported via non-destructive `mode: "append"` | ✅ Supported via non-destructive `mode: "append"` |

**Why iOS text is forwarded.** `input/typeText`'s default path *replaces* the focused field's
contents, so a client that forwards each character must use `mode: "append"`. Android realizes
append through real key events. iOS routes append through CtrlProxy's focused-field insertion
primitive, which calls XCUITest `typeText` at the current caret without clearing or resolving a
resource ID. Runners that predate the dedicated append command use the existing untargeted
`request_set_text` command, which performs that same focused-field insertion. Control clients
therefore forward printable ASCII text on both platforms, always in append mode. Discrete iOS keys
remain unsupported.

Uppercase/shifted characters on Android need `input keycombination`, available only on API 31+. A
client cannot see the device API level, so it forwards them anyway; an older device answers with an
actionable error the client surfaces — a reported failure, not a silent loss.

## Manual smoke plan

No automated end-to-end coverage drives a real device screen from a mirror, so control is
smoke-tested by hand. Run this after any change to the control path, on each platform, with the
desktop app (or your client) connected to the daemon and a device/simulator streaming.

**Android** (emulator or device):

1. Enter control mode (open the Live Layout view on a real, selected device with a live frame).
2. **Tap** a button; confirm the device actuates it and the touch pulse appears where you clicked.
3. **Swipe** to scroll a list; confirm the list scrolls and a sub-24px nudge does nothing.
4. **Button** — press `Esc`; confirm the device navigates back.
5. **Text/keys** — focus a text field, type ASCII text (confirm it *appends*, not replaces),
   press Enter/Tab/arrows/Backspace; confirm each maps to the device.
6. Trigger a failure (e.g. overload the queue) and confirm the error banner shows and clears.

**iOS** (simulator):

1. Enter control mode as above.
2. **Tap** and **swipe** — confirm both actuate.
3. **Button** — `Esc` → back; confirm.
4. **Text/keys** — focus a text field and type ASCII text; confirm each character *appends* at the
   current caret without clearing the field. Confirm `input/key` presses surface an actionable
   error rather than being silently dropped.

> **Status:** this plan is written but **manual execution is pending** — the sign-off environment
> had no attached Android device or iOS simulator. Record pass/fail per step when a device fleet
> is available.

## Milestone sign-off and known deferrals

The Client Screen Control milestone is complete. The following are intentionally deferred and
tracked back to [#1099](https://github.com/kaeawc/auto-mobile/issues/1099):

| Issue | Deferred item |
| --- | --- |
| [#4502](https://github.com/kaeawc/auto-mobile/issues/4502) | Close the same-device rotation window in the client control-tap gate. |
| [#4533](https://github.com/kaeawc/auto-mobile/issues/4533) | Bound `ensureAdbPath` discovery so a cold cache cannot wedge the per-device input queue. |
| [#4534](https://github.com/kaeawc/auto-mobile/issues/4534) | Evict the append cache on rapid same-serial device reuse (needs a device-connect signal). |
| [#4535](https://github.com/kaeawc/auto-mobile/issues/4535) | Optional daemon capability signal for newer input params (e.g. `input/typeText mode:append`). |
| [#4536](https://github.com/kaeawc/auto-mobile/issues/4536) | Prefer a reliable native AltGraph signal over the `ctrl && alt` heuristic. |
