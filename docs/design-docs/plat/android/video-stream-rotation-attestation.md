# Video-Stream Display-Rotation Attestation

<kbd>🧭 Design</kbd>

> Records the wire-format decision for carrying display rotation end-to-end
> through the live video-stream pipeline so a device-control consumer can prove a
> live frame's orientation. Implements the protocol/attestation half of
> [#4786](https://github.com/kaeawc/auto-mobile/issues/4786); the capture-path
> half (recreating the encoder on rotation) shipped in
> [#4785](https://github.com/kaeawc/auto-mobile/issues/4785) /
> [#4947](https://github.com/kaeawc/auto-mobile/issues/4947).
>
> See the [Status Glossary](../../status-glossary.md) for chip definitions.

## Problem

The live video-stream protocol carries no display-rotation metadata, so no
consumer can prove a frame's orientation. `DeviceControlSession` already reads
`liveFrame?.rotation` in its proven-rotation gate (`hasProvenRotationDifferentFrom`
/ `provenRotations`), but `LiveVideoFrame.rotation` was never populated — the
consumer side was built and waiting. After a mid-stream rotation, device control
therefore stayed blocked/degraded until a screenshot/hierarchy source re-proved
orientation.

Dimensions alone cannot substitute: a WxH↔HxW swap disambiguates portrait from
landscape but not rotation `0`-vs-`2` or `1`-vs-`3`. The control gate's
proven-rotation model needs the full `0..3` value.

## Pipeline (two protocol layers)

The live-mirror path has **two** binary framing layers, each with a Kotlin
producer and a matching parser that pin each other via contract tests:

```
device video-server ──layer 1──▶ daemon relay ──layer 2──▶ desktop VideoStreamClient
  VideoStreamProtocol.kt         videoStreamSocketServer.ts   VideoStreamParser.kt
  (encode)                       (re-frame)                   (decode)
       ▲                              ▲                            │
  VideoServerStreamParser.ts     videoStreamFraming.ts       LiveVideoFrame.rotation
  (layer-1 decode, in daemon)    (layer-2 encode)                 │
                                                            DeviceControlSession gate
```

- **Layer 1 (device → daemon):** `VideoStreamProtocol.kt` encodes; the daemon's
  `VideoServerStreamParser.ts` decodes. Config packets carry SPS/PPS.
- **Layer 2 (daemon → desktop):** the daemon re-frames the normalized Annex-B
  stream with `videoStreamFraming.ts`; the desktop's `VideoStreamParser.kt`
  decodes into `LiveVideoFrame`.

Rotation must cross **both** layers to reach `LiveVideoFrame.rotation`.

## Decision 1 — Rotation rides the CONFIG packet

Rotation rides the **video CONFIG packet** (the SPS/PPS packet, `PACKET_FLAG_CONFIG`),
not a one-shot stream-header field, because:

1. A config packet is already emitted at stream start **and** on every encoder
   swap — including [#4785](https://github.com/kaeawc/auto-mobile/issues/4785)'s
   rotation-driven swap, which tears down the old encoder and brings up a new one
   at the post-rotation dimensions. The new encoder's SPS/PPS is a fresh config
   packet, so rotation is re-attested exactly when it changes.
2. The config packet is stored in `VideoStreamWriter`'s replay cache
   (`VideoPacketCache`). A late-attaching or reconnecting client replays the
   **current** config packet, so it replays the current rotation for free.

A one-shot stream-header rotation field would go stale after the first rotation —
the header is written once per client attach, never re-sent mid-stream — so it
was rejected.

## Decision 2 — Encoding: 2 bits carved from `ptsAndFlags`

Rotation `0..3` is carved into 2 previously-unused bits of the 64-bit
`ptsAndFlags` word, interpreted **only on config packets**.

### Layer 1 bit layout (`VideoStreamProtocol.kt` ↔ `VideoServerStreamParser.ts`)

| Bit(s) | Meaning                  | Before          | After                           |
| ------ | ------------------------ | --------------- | ------------------------------- |
| 63     | `CONFIG`                 | ✓               | ✓                               |
| 62     | `KEY_FRAME`              | ✓               | ✓                               |
| 61     | `REPLAYED`               | ✓               | ✓                               |
| 60–59  | `ROTATION` (config only) | _(part of PTS)_ | **new**                         |
| 58–0   | PTS (µs)                 | bits 0–60       | bits 0–58 (`PTS_MASK` narrowed) |

`ROTATION_SHIFT = 59`, `ROTATION_MASK = 0b11 << 59`, `PTS_MASK = (1 << 59) - 1`.

### Backward-compatibility argument (verified against the code)

A real presentation timestamp is in **microseconds**. Bit 59 has place value
`2^59 µs ≈ 5.76e17 µs ≈ 1.8e4 years`, so a genuine PTS never sets bits 59–60.
Therefore:

- **Old encoders** wrote `0` into bits 59–60 (they were the low PTS bits, always
  zero for real timestamps).
- **Old parsers** read bits 59–60 as (zero) PTS bits, so masking them off in the
  new parser changes no observable PTS.
- **New parsers** reading an old stream see rotation bits `0` → rotation `0`.

The last point is safe on layer 1 by a stronger property than the always-zero
argument: the daemon **always pushes and integrity-verifies its own bundled jar**
([#4733](https://github.com/kaeawc/auto-mobile/issues/4733)), so a v2 daemon
never reads a v1 persistent-encoder stream. Every config packet the layer-1
parser sees is from a matching v2 jar and carries a real rotation. Non-attesting
sources (screenrecord fallback, iOS) emit raw Annex-B with **no** layer-1 framing
at all — they never reach `VideoServerStreamParser`. So on layer 1, "config
packet ⇒ rotation is present and valid"; no presence bit is needed.

### Layer 2 bit layout (`videoStreamFraming.ts` ↔ desktop `VideoStreamParser.kt`)

The relay aggregates from possibly-**non-attesting** sources (screenrecord, iOS),
so here rotation may be absent. Layer 2 has no `REPLAYED` flag, so **bit 61 is
free** and is repurposed as a `ROTATION_PRESENT` marker:

| Bit(s) | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| 63     | `CONFIG`                                                       |
| 62     | `KEY_FRAME`                                                    |
| 61     | `ROTATION_PRESENT` (config only)                               |
| 60–59  | `ROTATION` (config only)                                       |
| 58–0   | PTS (µs), `PTS_MASK = (1 << 59) - 1` (narrowed from bits 0–61) |

The desktop parser returns `rotation: Int? = null` unless a config packet has bit
61 set; only then does it read bits 59–60. This cleanly encodes "unknown" (no
bit) distinctly from the valid value `0`. Backward compatible: the old relay
never set bit 61 and PTS never reaches it, so old streams decode to `null`
(control fails closed, the prior behavior).

The two layers deliberately assign bit 61 different meanings (`REPLAYED` vs
`ROTATION_PRESENT`). They are separate protocols with separate parsers and
already-different PTS masks; the asymmetry is intentional and documented here so
the relay never conflates them.

## Decision 3 — Versioning

`MUX_VERSION` is bumped **1 → 2** in the layer-1 mux header to signal v2
semantics. The legacy 12-byte header (`legacyHeader`, video-only — the common
case when audio is disabled) stays byte-for-byte decodable; the parser still
accepts it unchanged.

The **legacy (non-mux) path attests rotation via the same config-packet bits and
needs no version field**, justified by the layer-1 argument above: the always-zero
property plus the jar-integrity coupling mean a v2 daemon only ever reads a v2
jar's config packets, whether the header is mux or legacy. Gating attestation on
`MUX_VERSION` would have left the common video-only path un-attested, defeating
the feature.

Layer 2 needs no version field: the `ROTATION_PRESENT` bit is self-describing and
safe by the always-zero argument.

## Decision 4 — Stale header dimensions

The one-shot header width/height go stale after a rotation-driven encoder swap
(a known leftover from [#4785](https://github.com/kaeawc/auto-mobile/issues/4785)).
Semantics are pinned as:

- **Header dims = initial only.** Advisory, for sizing a surface before the first
  keyframe. Not re-sent on rotation.
- **Authoritative dims come from the in-band H.264 SPS**, which the decoder reads
  and which changes on rotation (`VideoStreamState.Streaming(width, height)` is
  already updated from the decoded frame, not the header).
- **Rotation comes from the config-packet metadata** defined here.

## Decision 5 — Replay-cache ordering

`VideoStreamWriter` replays cached config + IDR to a replacement/reconnecting
client. Because rotation rides the config packet itself, the existing replay
already carries the current rotation — the same `VideoPacketCache` entry holds
both the SPS/PPS bytes and the rotation bits. The rotation-swap path already
resets the cache atomically before the new encoder's config repopulates it
(`resetReplayCacheForResize`), so a reconnecting client can never replay a stale
rotation paired with new parameter sets. On layer 2, the relay includes the
current rotation in the parameter-set replay it sends a late joiner
(`replayParameterSets`). Both are covered by tests.

## Files

- **Layer-1 protocol:** `android/video-server/.../VideoStreamProtocol.kt`
- **Layer-1 producer:** `android/video-server/.../VideoStreamWriter.kt`,
  `VideoServer.kt`
- **Layer-1 parser (daemon):** `src/features/webrtc/VideoServerStreamParser.ts`,
  `PersistentEncoderH264Source.ts`
- **Layer-2 producer (daemon):** `src/daemon/videoStreamFraming.ts`,
  `videoStreamSocketServer.ts`
- **Layer-2 parser (desktop):** `android/desktop-core/.../video/VideoStreamParser.kt`,
  `VideoStreamClient.kt`
- **Consumer:** `android/desktop-core/.../AutoMobileContent.kt`
  (`LiveVideoFrame.rotation`), consumed by
  `control/DeviceControlSession.kt` (unchanged).
