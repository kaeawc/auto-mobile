# Client Screen Control: frame snapshots and post-input refresh

<kbd>🚧 In progress</kbd>

Part of milestone 28 (Client Screen Control), parent [#1099](https://github.com/kaeawc/auto-mobile/issues/1099).
Shipped by [#3348](https://github.com/kaeawc/auto-mobile/issues/3348).

[Screen Control Mapping](screen-control-mapping.md) specifies how a viewport pixel
becomes a device coordinate. This document specifies the other half a control
client needs: **which frame that mapping is allowed to run against**, and **what
the client shows after it forwards an input**. Both are written so a third-party
daemon client can follow them without reading any Compose code; the desktop
inspector is the reference implementation.

## Why a snapshot

A client that both renders a device and controls it assembles its picture from
several sources that update independently:

| Source | Carries | Updates |
| --- | --- | --- |
| observation stream `screenshot_update` | pixels, reported screen size, daemon capture timestamp | continuously while subscribed |
| observation stream `hierarchy_update` | element tree with `bounds`, daemon capture timestamp | continuously, usually debounced client-side |
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
  sequence,             // monotonic; orders snapshots against each other
  capturedAtMs,         // client clock, for recency
  source,               // Screenshot | LiveVideo — which pixels are displayed
  frameWidth/Height,    // the displayed frame's dimensions
  deviceWidth/Height,   // the effective device bounds used for mapping
  hierarchy,            // paired in, not independently debounced into view state
)
```

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
| `abs(screenshot.daemonTimestamp - hierarchy.daemonTimestamp) <= 1500 ms` | **Provenance pairing** — this is what catches the equal-aspect resolution change |
| `now - screenshot.receivedAt <= 5000 ms` | The daemon may stop pushing without disconnecting |
| `now - liveFrame.receivedAt <= 1000 ms` (when a live frame is displayed) | **Recency** — this is what catches the stalled mirror |
| Displayed frame and mapping bounds agree in aspect | A cross-check for the live path, which has no daemon timestamp to pair against |

Two clock rules matter for a correct port:

- **Daemon timestamps are compared only to each other.** They order the two
  observation sources relative to one another; they are not comparable to the
  client's wall clock.
- **Client receive instants are compared only to the client clock.** They answer
  "did this source stop producing?".

Absolute dimensions are deliberately **not** compared between the frame and the
mapping bounds: a screenshot may be a downscale of the device screen, and iOS
hierarchy bounds are logical points against pixel screenshots. That is exactly why
an aspect check alone cannot catch an equal-aspect resolution change, and why
pairing by provenance does.

Because staleness is the passage of time rather than an event, a client must
re-evaluate availability on a timer as well as on source updates. A stalled relay
produces nothing at all.

## Post-input refresh policy

The daemon's input responses (`input/tap` and its siblings) return the action
result only. They do **not** carry a fresh observation and do **not** implicitly
trigger one, so the client decides when its picture is current again.

**Consume the next superseding snapshot from the observation stream you are
already subscribed to. Do not poll, and do not issue a separate `observe` call.**

Expressed as snapshot transitions:

| Event | Transition | What the client renders |
| --- | --- | --- |
| Input forwarded successfully | `Idle -> AwaitingSnapshot`, recording the dispatched `sequence` | The pre-input snapshot, unchanged and still clickable — it is the best available truth |
| First snapshot with a strictly greater `sequence` | `AwaitingSnapshot -> Settled` | The new snapshot |
| No superseding snapshot within 3000 ms | `AwaitingSnapshot -> Settled` | Whatever is current; the freshness bound above independently retires the stale frame and drops control |
| Input failed or was rejected | `-> Settled` immediately | Unchanged state plus the daemon's actionable error |
| Device switch, stream disconnect, mode change | `-> Idle` | A pending wait is dropped; an input from the previous context never settles one in the new context |

Two consequences worth stating explicitly:

- **Settling implies both sources caught up.** A snapshot exists only when its
  screenshot and hierarchy are paired, so a client can never settle on a fresh
  screenshot that still carries the pre-input hierarchy.
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

## Reference implementation

| Concern | Type | Module |
| --- | --- | --- |
| Snapshot + source provenance | `DeviceFrameSnapshot`, `ScreenshotFrameFacts`, `HierarchyFrameFacts`, `LiveFrameFacts` | `desktop-domain` |
| Availability rules | `DeviceControlPolicy` | `desktop-domain` |
| Refresh transitions | `PostInputRefreshTracker` | `desktop-domain` |
| Dispatch, ordering, error gating, reset | `DeviceControlSession` | `desktop-core` |

All four are Compose-free with the clock injected, so they are unit tested with
fakes and no device, socket or real timer.

## Scope note

This is the **client-side** consolidation. The durable cross-client fix — echoing
frame identity on `input/*` so the *daemon* rejects stale-context input, which
protects third-party clients that will not reimplement these rules — is tracked
separately under [#4505](https://github.com/kaeawc/auto-mobile/issues/4505) and
[#1099](https://github.com/kaeawc/auto-mobile/issues/1099).
