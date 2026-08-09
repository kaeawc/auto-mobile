# Client Screen Control: frame snapshots and post-input refresh

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

Part of milestone 28 (Client Screen Control), parent [#1099](https://github.com/kaeawc/auto-mobile/issues/1099).
Shipped by [#3348](https://github.com/kaeawc/auto-mobile/issues/3348).
New to screen control? Start at the
[third-party client guide](client-screen-control.md) for the end-to-end picture.

[Screen Control Mapping](screen-control-mapping.md) specifies how a viewport pixel
becomes a device coordinate. This document specifies the other half a control
client needs: **which frame that mapping is allowed to run against**, and **what
the client shows after it forwards an input**. Both are written so a third-party
daemon client can follow them without reading any Compose code.

## Why a snapshot

A client that both renders a device and controls it assembles its picture from
several sources that update independently:

| Source | Carries | Updates |
| --- | --- | --- |
| observation stream `screenshot_update` | pixels, reported screen size, `captureSequence`, `coordinateSpace`, `nativeScale`, device `frameContext` | continuously while subscribed |
| observation stream `hierarchy_update` | element tree with `bounds`, `captureSequence`, `coordinateSpace`, `nativeScale`, device `frameContext` | continuously, usually debounced client-side |
| live mirror relay (optional) | decoded video frames | at the mirror's frame rate |
| daemon connection state | transport liveness | on connect/disconnect |
| device selection | which device the user chose | on user action |

A click is mapped with one source's geometry and dispatched against another's
device id, so a client that checks these sources *individually at click time*
accumulates one check per discovered disagreement — and two disagreements cannot
be checked for at all by comparing what the sources report:

- **Equal-aspect resolution change.** The device goes from 1080x2340 to 720x1560.
  A new screenshot arrives; the hierarchy has not caught up. The aspect ratios are
  identical, so no dimension comparison distinguishes them — but mapping through
  the stale hierarchy's absolute bounds sends a center tap as (540,1170) instead
  of (360,780).
- **Stalled mirror with unchanged geometry.** The relay stalls in a blocking read
  while keeping its socket open. The client keeps its last decoded frame,
  unchanged dimensions and a "streaming" state, so the user clicks frozen content
  with every dimension check satisfied.

Both require knowing **which frame** the pixels came from. So control acts on an
immutable snapshot assembled before the UI layer, and decides on provenance.

## The snapshot

```text
DeviceFrameSnapshot(
  deviceId,             // the one device every contributing source agreed on
  sequence,             // monotonic; orders snapshots against each other (see below)
  captureSequence,      // the daemon capture identity screenshot and hierarchy agreed on
  frameContext,         // device-authored identity screenshot and hierarchy agreed on
  capturedAtMs,         // client clock, for recency
  source,               // Screenshot | LiveVideo — which pixels are displayed
  frameWidth/Height,    // the displayed frame's dimensions
  deviceWidth/Height,   // the effective device bounds used for mapping
  hierarchy,            // paired in, not independently debounced into view state
  liveFrameSequence,    // the mirror's own provenance, a SEPARATE counter domain
)
```

`sequence` is derived from the **observation-source counter only** — the newer of
the screenshot's and hierarchy's sequences, which share one counter domain. It is
guaranteed monotonic non-decreasing for the lifetime of a session, which is what
the refresh policy's "strictly greater sequence" condition relies on. The live
mirror's frames are counted in a *different* domain (per mirror connection), so
they are deliberately excluded: folding them in with a max would make `sequence`
jump while a mirror is connected and fall back when it clears. The mirror's
provenance is carried separately in `liveFrameSequence`.

Contract:

1. A click is mapped through **exactly the snapshot the user clicked**, and that
   snapshot travels with the input all the way to the daemon request. A snapshot
   swap between click and dispatch cannot change the mapping or the target device.
2. The snapshot's `deviceWidth`/`deviceHeight` — not live view state — are the
   device-coordinate space for [the mapping formulas](screen-control-mapping.md).
3. Control is available **only** when a snapshot exists. Every failure falls back
   to inspector mode; there is no partial control state.

## Availability rules

A snapshot is produced only when all of the following hold. Each is a rule of a
pure function of its inputs plus the current client clock, so it is reproducible
and unit-testable without a device.

| Rule | Why |
| --- | --- |
| The client opted into control | Inspector-only hosts (e.g. an IDE plugin) never enable it |
| Real device data, not mock data | Nothing to actuate otherwise |
| A device is explicitly selected | A null selection would let the daemon pick a device the user never chose |
| The transport can carry daemon input | Not every connection exposes `input/*` |
| The observation stream is connected | A dead stream means the on-screen mirror is frozen |
| A screenshot **and** a hierarchy have been applied | Mapping needs both |
| Every source's device id equals the selection | After a device switch the previous device's frame lingers |
| `screenshot.captureSequence == hierarchy.captureSequence` | **Shared capture identity** — this is what catches the equal-aspect resolution change |
| `screenshot.frameContext == hierarchy.frameContext`, both non-null | **Device capture identity** — this catches same-size navigation between request and pixel capture |
| Both messages carry a `captureSequence` at all | Older daemons do not stamp one; control fails closed rather than guessing |
| `now - screenshot.receivedAt <= 5000 ms` | The daemon may stop pushing without disconnecting |
| `now - liveFrame.receivedAt <= 1000 ms` (when a live frame is displayed) | **Recency** — this is what catches the stalled mirror |
| Displayed **screenshot** and mapping bounds agree — **exactly** (rotation-tolerant) when both messages declare `coordinateSpace: "px"`, **in aspect** (±5%) when they do not | One unit means absolute dimensions are comparable; a legacy frame reports iOS pixels against point-space bounds and cannot be — see [Coordinate space](#coordinate-space-canonical-pixels) |
| Displayed **live mirror frame** matches the mapping bounds EXACTLY | See below — an aspect check would accept a scale change |

### Coordinate space: canonical pixels

Every geometry-bearing message declares its coordinate space with a
`coordinateSpace` field. `"px"` means the message's element `bounds` and screen
`screenWidth`/`screenHeight` are **canonical physical pixels** — the daemon
converted the runner's logical points using the runner-reported `nativeScale`
(issue [#4548](https://github.com/kaeawc/auto-mobile/issues/4548)), so a screenshot
and the hierarchy that describes it share one unit and compare **exactly** (the
rotation W/H swap for native-portrait screenshots is still accepted). Android
bounds are already physical pixels (`nativeScale` 1), so it declares `"px"` too.
Both messages in a controllable pixel snapshot must carry the same finite,
positive `nativeScale`; missing or mismatched metadata fails control closed.

The field is **absent** when the runner supplied no scale metadata (a pre-#4548
runner). That is the **legacy fallback**: `bounds` stay in logical points while
the screenshot is pixels — the mixed-unit state that predates canonical pixels —
and a client keeps its aspect-only (±tolerance) geometry check. A client that
sees no `coordinateSpace` must not assume pixels; a client that sees `"px"` can
compare absolute dimensions exactly. On the input side, a client that renders a
`"px"` frame sends `input/*` coordinates in **pixels**; the daemon divides by
`nativeScale` (an exact fractional quotient — the runner takes `Double` points)
before dispatching to the iOS runner, so the physical tap location is unchanged.
A **third** state exists and must not be folded into either: a `coordinateSpace`
the client does not recognize. That is a daemon newer than the client, whose
geometry it cannot interpret and whose `input/*` unit it cannot know, so control
must **fail closed** with a distinct "unsupported coordinate space" reason rather
than degrade to the legacy path. Absent means "a daemon I understand"; unknown
means "a daemon I do not". Only absent takes the aspect-only fallback.

The two comparison modes are all-or-nothing per snapshot: the exact check runs
only when the screenshot **and** the hierarchy both declare `"px"`. One declared
message paired with one undeclared message is precisely the mixed-unit state the
exact check must not be applied to, so it takes the legacy path
([#4550](https://github.com/kaeawc/auto-mobile/issues/4550)).

**Bind the space and scale to the frame, and retire a retained frame when either changes.** The
daemon converts an incoming `input/tap` or `input/swipe` coordinate using the
runner's **current** scale metadata, not the frame's. That is safe while a client
acts on the frame it is rendering, but the [post-input refresh](#post-input-refresh-policy)
deliberately keeps the clicked frame **clickable** while its sources move on. If
scale metadata appears (or a runner downgrade removes it) during that window, a
coordinate mapped in one space would be converted as though it were in the other
and land in the wrong physical place. So a client must:

- record the agreed space and `nativeScale` **on the snapshot**, alongside its capture identity, and
- stop acting through a retained snapshot as soon as an incoming `hierarchy_update`
  or `screenshot_update` declares a different space or `nativeScale` — retire it exactly like a
  stale one and drop to inspector behavior until a fresh, agreed frame arrives.
  Both messages are checked independently, and a move into (or out of) an
  *unrecognized* space counts as a change like any other.

**Check the declaration when the message ARRIVES, not when your frame state
catches up.** The daemon starts converting input under the new scale metadata the
moment it publishes the new declaration. A client that parses hierarchies
off-thread, or debounces its layout state (the reference client does both), would
otherwise leave a frame clickable in the old unit for the whole of that lag — and
a tap in that window is mapped in one unit and converted as the other. Read
`coordinateSpace` off the raw message first, before any parsing or coalescing,
and invalidate there.

One consequence worth calling out: a **live mirror** frame on iOS is verifiable
again. The live-frame check below has always demanded an exact match, which a
point-space hierarchy could never satisfy against pixel mirror frames; published
in pixels, the mirror matches its mapping bounds and control stays available
while mirroring.

### Pairing is identity, never elapsed time

The daemon assigns a monotonic `captureSequence` on every `hierarchy_update` it
pushes. A `screenshot_update` carries that id **only when the daemon has verified
that the frame's real pixel dimensions match the geometry its capture client
claimed for it**; otherwise the field is absent. Equal ids therefore mean "these
two messages describe the same captured device state" — a fact, not an inference.

That verification is the load-bearing part. A capture client's declared
`screenWidth`/`screenHeight` are read from a screen-dimension cache derived from
the last hierarchy it processed, so they are a *claim*, not a measurement: when
the device resolution changes, a screenshot can carry fresh 720x1560 pixels while
the cache — and the claim — is still the previous 1080x2340. Echoing "the newest
hierarchy pushed for this device" onto such a frame would stamp the stale
geometry's id onto new pixels and let a client pair them, reintroducing the exact
mis-scaled tap one level down. So the daemon measures the frame's header and
refuses to stamp on mismatch. It also publishes the *measured* dimensions, so a
client falling back to them maps through the pixels it is actually rendering.

### Device capture identity

Identity is bound when the client **sends** the screenshot request, not when the
device actually captures the pixels. The device captures some time later, so if
navigation reaches a **same-size** screen inside that window, screen B's pixels
carry screen A's identity and pair with screen A's hierarchy. No client-side
signal distinguishes this: the dimensions are identical, and the client has no
visibility into what was on screen at capture time.

A CtrlProxy runner that supports frame context reports an opaque `frameContext`
with each hierarchy and with a screenshot only when it can prove the hierarchy
stayed unchanged across pixel capture. A control client requires matching,
non-null contexts alongside `captureSequence`, then echoes that exact value on
`input/*`. The daemon rejects a stale or unavailable echo before executing the
request. The token is opaque, device-specific, and must never be synthesized or
compared across reconnects.

The default `0.0.51` CtrlProxy artifacts predate this protocol. A client must
treat those artifacts as legacy and remain in inspector mode until its runner
publishes `frameContext`.

The identity source is monotonic for the daemon process's lifetime and is never
reset, so an id cannot be reused after a device reconnect and collide with a
pre-drop hierarchy a client still holds. On connection loss the device's *current*
id is dropped, so screenshots arriving before the first post-reconnect hierarchy
carry none.

A frame gets no identity — and the client fails closed with
`CaptureIdentityUnavailable` — whenever it cannot be proven: unmeasurable bytes, a
caller whose dimensions have no tracked capture (e.g. a one-off screenshot that
reads its own PNG header), before the first hierarchy, or after a reconnect.

Two things that look like they would work, and do not:

- **An elapsed-time window between the two messages.** After an aspect-preserving
  resolution change the new screenshot and the not-yet-applied older hierarchy are
  *milliseconds* apart, so any window wide enough for normal streaming also admits
  the mis-scaled pair. Worse, the two `timestamp` fields are not even from one
  clock: a hierarchy's originates on the **device** (its own wall clock, forwarded
  unchanged) while a screenshot's is stamped by the **daemon**, so their difference
  is dominated by clock skew. Treat `timestamp` as display-only.
- **Comparing absolute dimensions.** Even under canonical pixels, where the
  comparison *is* exact, two captures of different content at the same resolution
  are dimensionally identical — and that is the ordinary case. In the legacy space
  it is weaker still: iOS reports screen size in pixels against hierarchy bounds in
  logical points, a uniform scale indistinguishable from a uniform resolution
  change.

The only time values this policy compares are **client-stamped receive instants
against the client's own clock**, for recency. No comparison mixes clocks.

That client clock must be **monotonic**, not wall time. A wall clock can step
backwards (NTP correction, a manual change, a VM or laptop resuming); a backwards
step while a source is stalled makes a frame's computed age negative, so every
freshness bound passes and a frozen mirror stays controllable. Reserve wall time
for display timestamps.

Because staleness is the passage of time rather than an event, a client must
re-evaluate availability on a timer as well as on source updates. A stalled relay
produces nothing at all.

### Live mirror frames carry no identity

The WebRTC mirror is a separate transport with no link to the observation
stream's captures, so none of the pairing above says anything about its pixels.
Their dimensions are all that is left, and an aspect check accepts any uniform
scale — a fresh 720x1560 mirror frame passes against 1080x2340 mapping bounds,
and a center click is then sent as (540,1170) instead of (360,780).

A client displaying a live mirror frame must therefore require its dimensions to
match the mapping bounds **exactly**, which is the only thing that excludes a
scale change. Under `coordinateSpace: "px"` that match is achievable on both
platforms: the hierarchy reports the same physical pixels the mirror decodes. In
the **legacy** space it is not — iOS reports hierarchy bounds in logical points
against pixel frames — and there control is **blocked** rather than acting on an
unverifiable pair. Losing control while mirroring is acceptable; sending a
mis-scaled tap to real hardware is not. Giving live frames
a real capture identity needs WebRTC-side plumbing, tracked under
[#1099](https://github.com/kaeawc/auto-mobile/issues/1099).

## Post-input refresh policy

The daemon's input responses (`input/tap`, `input/swipe` and their siblings)
return the action result only. They do **not** carry a fresh observation and do
**not** implicitly trigger one, so the client decides when its picture is current
again. This applies identically to every forwarded input: a successful swipe
starts the same wait, on the same tracker, as a successful tap.

All forwarded inputs also share **one** ordered, bounded dispatch queue, so a
tap-then-swipe-then-type sequence reaches the device in the order the user made
it. A per-action queue would reintroduce the ordering race the single queue
exists to remove.

**Consume the next superseding snapshot from the observation stream you are
already subscribed to. Do not poll, and do not issue a separate `observe` call.**

Expressed as snapshot transitions:

| Event | Transition | What the client renders |
| --- | --- | --- |
| Input forwarded successfully | `Idle -> AwaitingSnapshot`, recording the dispatched `captureSequence` | The **retained** pre-input snapshot, unchanged and still clickable — it is the best available truth. A screenshot-only update in this interval carries a `captureSequence` the retained hierarchy does not match, so it yields no snapshot and does not replace what is on screen |
| Input not dispatched (off-screen point, a drag below the [swipe threshold](screen-control-mapping.md#drag-to-swipe-policy), a keystroke the [keyboard policy](screen-control-mapping.md#keyboard-forwarding-policy) declined, or the bounded queue rejected it) | no transition | Unchanged; nothing reached the device, so there is nothing to wait for |
| First snapshot from a strictly greater **capture** | `AwaitingSnapshot -> Settled` | The new snapshot |
| No superseding snapshot within 3000 ms | `AwaitingSnapshot -> Settled` | The retained snapshot is **released** and the view falls back to current state. Retention is bounded: if screenshots keep arriving but hierarchy updates stall, nothing ever pairs, and holding the pre-input frame past this point would pin the view to it indefinitely. The freshness bound above independently retires the stale frame and drops control |
| Input failed or was rejected | `-> Settled` immediately | Unchanged state plus the daemon's actionable error |
| Device switch, stream disconnect, mode change | `-> Idle` | A pending wait is dropped; an input from the previous context never settles one in the new context |

Two consequences worth stating explicitly:

- **Settling implies both sources caught up.** A snapshot exists only when its
  screenshot and hierarchy share a capture identity, so a client can never settle
  on a fresh screenshot that still carries the pre-input hierarchy. Note this must
  key on the **capture** id, not on the client's own per-update counter: that
  counter advances for every applied screenshot, including a duplicate or keepalive
  frame still belonging to the pre-input capture.

- **The retained snapshot owns its pixels.** While awaiting, the client renders the
  retained snapshot's *bytes and dimensions* as well as its tree. Pulling the bytes
  from newest-independent state would put new pixels on screen against the clicked
  snapshot's old hierarchy — the half-updated frame this policy exists to prevent.
- **A failed input clears nothing.** It did not change the device, so no rendered
  state is stale. Clearing the screenshot, hierarchy or selection on failure would
  destroy useful state for no reason.

### Selection and hover

Deterministic in every case:

- Control mode suppresses element selection and hover. Both are cleared when the
  view enters control mode and are never set while in it, so after a forwarded
  input — success or failure — selection and hover are null.
- On returning to inspector mode, selection is re-derived from the snapshot then
  current: a selected element id that no longer exists in the new hierarchy is
  dropped, which is the pre-existing inspector behavior.

## Legacy desktop implementation

The desktop inspector below implements the earlier capture-sequence policy, but
does not pair or echo `frameContext`. It is not a reference implementation for
this protocol until [#4596](https://github.com/kaeawc/auto-mobile/issues/4596)
lands.

| Concern | Type | Module |
| --- | --- | --- |
| Daemon capture identity | `captureSequence` on `hierarchy_update` / `screenshot_update` | `src/daemon/deviceDataStreamSocketServer.ts` |
| Snapshot + source provenance | `DeviceFrameSnapshot`, `ScreenshotFrameFacts`, `HierarchyFrameFacts`, `LiveFrameFacts` | `desktop-domain` |
| Availability rules | `DeviceControlPolicy` | `desktop-domain` |
| Refresh transitions | `PostInputRefreshTracker` | `desktop-domain` |
| Drag-to-swipe rules | `DeviceDragGesturePolicy` | `desktop-domain` |
| Keyboard/text/button rules | `DeviceKeyboardInputPolicy` | `desktop-domain` |
| Dispatch, ordering, error gating, reset | `DeviceControlSession` | `desktop-core` |

All of them are Compose-free with the clock injected, so they are unit tested with
fakes and no device, socket or real timer.

## Scope note

This is the **client-side** consolidation. For `input/tap` and `input/swipe`, the
daemon rejects a stale echoed context for every client, including one that does
not reimplement this policy. Device-boundary validation for the remaining input
methods is tracked separately under [#4586](https://github.com/kaeawc/auto-mobile/issues/4586).
