# werift H.264 sender packetization spike

## Decision

**No-go.** AutoMobile must retain its H.264 sender packetization path with
`werift@0.23.0`. The package has no public sender-side API that accepts
pre-encoded Annex-B H.264 and emits RFC 6184 RTP packets. Replacing the current
path would therefore require maintaining a private-package dependency or writing
the packetizer again behind a different interface. Neither reduces the code or
regression risk that motivated this spike.

This is a publisher-only decision. The supported MediaMTX fanout owns
subscriber forwarding; after [#4291](https://github.com/kaeawc/auto-mobile/issues/4291)
lands, the LOC snapshot below must be refreshed before treating it as the final
post-retirement measurement.

## Evidence

AutoMobile resolves `werift` to `0.23.0` in
[`bun.lock`](../../../../bun.lock). Its public package entrypoint is
[`lib/webrtc/src/index.d.ts`](https://unpkg.com/werift@0.23.0/lib/webrtc/src/index.d.ts),
which re-exports the RTP package surface. The installed
[`H264RtpPayload` declaration](https://unpkg.com/werift@0.23.0/lib/rtp/src/codec/h264.d.ts)
implements `DePacketizerBase` and exposes only `deSerialize`; it has no send or
packetize operation. Searching the shipped JavaScript and declarations found no
sender packetizer public API.

The public-surface probe had these results:

| Symbol                                                                | Result                                                          | Consequence                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `H264RtpPayload`                                                      | Exported; receive-side `deSerialize` only                       | It can consume existing RTP, not create outbound RTP from Annex-B. |
| `useH264`                                                             | Exported                                                        | It describes the negotiated codec; it does not packetize frames.   |
| `PictureLossIndication`, `GenericNack`                                | Exported                                                        | RTCP packet types, not capture-source recovery.                    |
| `NackHandler`                                                         | Not exported by either public entrypoint                        | It cannot be a supported replacement seam.                         |
| `JitterBufferBase`, `JitterBufferCallback`, `JitterBufferTransformer` | Exported only by the documented `werift/nonstandard` entrypoint | They are receiver utilities, not a sender-side H.264 packetizer.   |

`NackHandler` is a non-public implementation detail in werift's receiver
package. The jitter utilities are public through the explicitly nonstandard
entrypoint, but still operate on received RTP. The root-entrypoint runtime
probe below reports all four as `undefined`; depending on the non-public
`NackHandler` path would make AutoMobile's API contract more fragile, not less.

Reproduce the public-surface check against the lockfile-pinned package with:

```bash
bun -e 'import * as w from "werift"; console.log([
  "H264RtpPayload", "useH264", "NackHandler", "JitterBufferBase",
  "JitterBufferCallback", "JitterBufferTransformer"
].map(key => `${key}=${typeof w[key]}`).join("\\n"))'

bun -e 'import * as w from "werift/nonstandard"; console.log([
  "NackHandler", "JitterBufferBase", "JitterBufferCallback", "JitterBufferTransformer"
].map(key => `${key}=${typeof w[key]}`).join("\\n"))'
```

## Parity experiment

The current packetizer was exercised with a 32-byte IDR NAL and a 12-byte RTP
payload MTU, producing four FU-A packets. Feeding those packets to
`H264RtpPayload.deSerialize` reassembled the original Annex-B NAL. This proves
the useful direction of compatibility: AutoMobile's sender output is accepted by
werift's H.264 receiver implementation. It does **not** establish a sender
replacement, because the candidate API performs no outbound packetization.

The focused regression suite also passed:

```text
bun test test/features/webrtc/RtpH264TrackWriter.test.ts \
  test/features/webrtc/WebRtcPublisher.test.ts
```

Those tests cover FU-A boundaries, marker placement, 90 kHz timestamps,
SPS/PPS re-injection before an IDR, and throttled picture-loss handling. The
MediaMTX + Chrome decoder test remains the end-to-end check for any future
sender change; it is intentionally opt-in because it requires MediaMTX, FFmpeg,
and Chrome. See
[`mediamtxWebRtcPublisher.integration.test.ts`](../../../../test/integration/mediamtxWebRtcPublisher.integration.test.ts).

## Responsibility map

| AutoMobile responsibility                                      | Existing implementation                                | werift equivalent                                                                    | Must remain?                                      |
| -------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Arbitrary-chunk Annex-B parsing                                | `VideoServerStreamParser` and `H264AnnexBParser`       | None                                                                                 | Yes                                               |
| Access-unit assembly                                           | `H264AccessUnitAssembler`                              | None                                                                                 | Yes                                               |
| Single-NAL and FU-A packetization                              | `packetizeNalUnit`                                     | None                                                                                 | Yes                                               |
| RTP sequence number, marker bit, and 90 kHz timestamp creation | `RtpH264TrackWriter`                                   | Sender normalizes packets after `MediaStreamTrack.writeRtp`; it does not create them | Yes                                               |
| SPS/PPS cache and IDR re-injection                             | `RtpH264TrackWriter`                                   | None                                                                                 | Yes                                               |
| Incoming PLI dispatch                                          | werift sender `onPictureLossIndication`                | Already used by `WebRtcPublisher`                                                    | The subscription and local recovery policy remain |
| Requesting an encoder IDR                                      | `onKeyFrameRequest` and capture-source command channel | None                                                                                 | Yes                                               |

The PLI observation is important: AutoMobile is already using werift at the
appropriate WebRTC boundary. Its sender dispatches an incoming
`PictureLossIndication` to `onPictureLossIndication`; AutoMobile's remaining
work is the intentionally local policy to throttle requests. The persistent
Android encoder accepts an on-demand request, `screenrecord` rotates its segment
to produce a new IDR, and iOS relies on its bounded GOP because FFmpeg cannot be
signalled for a keyframe mid-stream.

## LOC measurement and follow-up

This pre-#4291 snapshot counts the exclusively publisher-side H.264 surface:

| File                                             |   Lines | Replaceable by public werift sender API |
| ------------------------------------------------ | ------: | --------------------------------------- |
| `src/features/webrtc/h264.ts`                    |     267 | 0                                       |
| `src/features/webrtc/RtpH264TrackWriter.ts`      |     216 | 0                                       |
| `src/features/webrtc/VideoServerStreamParser.ts` |     176 | 0                                       |
| **Total**                                        | **659** | **0**                                   |

No follow-up implementation issue should be filed. After #4291 merges, refresh
the table against `main`, retain this no-go unless werift gains a documented
public Annex-B-to-RTP sender API, and close
[#4299](https://github.com/kaeawc/auto-mobile/issues/4299) with this decision.

## Sources

- [`werift@0.23.0` package metadata](https://unpkg.com/werift@0.23.0/package.json)
  — public entrypoint and version inspected by this spike.
- [`H264RtpPayload` declaration](https://unpkg.com/werift@0.23.0/lib/rtp/src/codec/h264.d.ts)
  — receive-side `DePacketizerBase` contract.
- [`werift/nonstandard` declaration](https://unpkg.com/werift@0.23.0/lib/webrtc/src/nonstandard/index.d.ts)
  — documented nonstandard entrypoint that re-exports the receiver utilities.
- [`RTCRtpSender` implementation](https://unpkg.com/werift@0.23.0/lib/webrtc/src/media/rtpSender.js)
  — PLI dispatch to `onPictureLossIndication`.
- [RFC 6184](https://www.rfc-editor.org/rfc/rfc6184.html) — H.264 RTP
  payload framing and parameter-set rules that the retained sender preserves.
