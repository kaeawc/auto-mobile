import { randomUUID } from "node:crypto";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpPacket,
  useH264,
  usePCMU,
  type RTCIceServer,
  type RTCRtpReceiver,
} from "werift";
import { WEBRTC_H264_PROFILE_LEVEL_ID } from "../../src/features/webrtc/h264Level";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

/**
 * Reference WebRTC coordination server (a tiny SFU).
 *
 * AutoMobile publishers push H.264 to `ingest()` over WHIP; browsers pull the
 * same stream from `subscribe()` over WHEP. Incoming RTP is forwarded to every
 * subscriber of that stream. `listStreams()` / `getStream()` back the reconnect
 * API a frontend uses to discover streams and (re)connect.
 *
 * WHEP reference: https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep
 * RTP forwarding and H.264 packet semantics: RFC 3550 and RFC 6184
 * (https://www.rfc-editor.org/rfc/rfc3550.html and
 * https://www.rfc-editor.org/rfc/rfc6184.html).
 *
 * This is intentionally minimal (single-server, in-memory) — for production use
 * a hardened SFU such as MediaMTX, LiveKit, or Janus that also speaks WHIP/WHEP.
 */

export interface CoordinationServerOptions {
  /** ICE servers advertised to WHEP subscribers and surfaced in the reconnect API. */
  iceServers?: RTCIceServer[];
  /** How long to wait for ICE gathering (ms) before returning an SDP answer. */
  iceGatheringTimeoutMs?: number;
  /** Injected so delayed replay remains deterministic in tests. */
  timer?: Timer;
}

export interface StreamDescriptor {
  streamId: string;
  state: "connecting" | "live" | "ended";
  subscriberCount: number;
  createdAt: string;
  /** Relative WHEP endpoint a browser POSTs its offer to. */
  whepUrl: string;
  /** ICE servers a browser should use to connect. */
  iceServers: RTCIceServer[];
  /** Frames forwarded from the publisher so far. */
  framesForwarded: number;
  /** Whether the publisher negotiated an audio track. */
  audio: boolean;
  /** Audio RTP packets forwarded from the publisher so far. */
  audioPacketsForwarded: number;
}

interface Subscriber {
  id: string;
  pc: RTCPeerConnection;
  tracks: Map<"audio" | "video", MediaStreamTrack>;
  /**
   * Per-subscriber sequence-number rewriters wrapping each outbound track. All
   * RTP (cached replay + live) for a subscriber flows through these so the
   * replay→live seam carries a gap-free sequence space (see
   * {@link SubscriberRtpForwarder}).
   */
  forwarders: Map<"audio" | "video", SubscriberRtpForwarder>;
  /** Video only begins forwarding after the cached keyframe has been replayed. */
  ready: boolean;
  /**
   * True when the subscriber connected before any keyframe was available (or was
   * migrated from a prior publisher session): replay is deferred until the
   * stream's next keyframe completes.
   */
  awaitingReplay: boolean;
}

interface StreamEntry {
  streamId: string;
  /** Opaque WHIP resource id; distinct from the user-visible stream id. */
  ingestSessionId: string;
  ingestPc: RTCPeerConnection;
  inboundTracks: Map<"audio" | "video", MediaStreamTrack>;
  subscribers: Map<string, Subscriber>;
  createdAt: string;
  framesForwarded: number;
  audioPacketsForwarded: number;
  /** Latest standalone SPS/PPS packets, kept to build the atomic replay snapshot. */
  videoConfig: RtpPacket[];
  /**
   * Atomic replay snapshot: the SPS/PPS + a complete IDR access unit captured at
   * the same instant, so a late viewer always receives a self-consistent
   * decoder-init sequence (not parameter sets from one frame stitched to an IDR
   * from another). Empty until the first keyframe completes.
   */
  videoReplay: RtpPacket[];
  collectingKeyFrame: RtpPacket[] | null;
  collectingKeyFrameTimestamp: number | null;
  /** Ingest video receiver, used to relay downstream PLI upstream to the publisher. */
  videoReceiver: RTCRtpReceiver | null;
  /** SSRC of the inbound video, learned from the first RTP packet. */
  videoInboundSsrc: number | null;
  /** Wall-clock ms of the last PLI relayed upstream (throttle guard). */
  lastUpstreamPliMs: number;
  iceEtag: string;
  iceCredentials: { ufrag: string; pwd: string };
}

export interface RtpOutboundTrack {
  writeRtp(rtp: RtpPacket): void;
}

/**
 * Rewrites RTP sequence numbers into one contiguous per-subscriber space.
 *
 * werift's sender forwards sequence numbers unchanged (it only rewrites SSRC and
 * payload type). A late viewer receives replayed cached packets (carrying the
 * publisher's *older* sequence numbers) and then live packets (the publisher's
 * *current* sequence numbers); the intervening range was never sent, so libwebrtc
 * treats it as a burst loss — an unanswerable NACK/PLI storm — and never renders.
 * Assigning gap-free numbers here removes that discontinuity.
 *
 * Timestamps are passed through unchanged: audio and video ride the publisher's
 * shared 90 kHz / 8 kHz RTP clocks, so rewriting one but not the other would
 * break A/V sync. The replay→live timestamp step reflects real elapsed capture
 * time, which the receiver treats as a media-time discontinuity, not loss.
 */
export class SubscriberRtpForwarder implements RtpOutboundTrack {
  private sequenceNumber: number;

  constructor(
    private readonly sink: RtpOutboundTrack,
    initialSequenceNumber = 0
  ) {
    this.sequenceNumber = initialSequenceNumber & 0xffff;
  }

  writeRtp(rtp: RtpPacket): void {
    rtp.header.sequenceNumber = this.sequenceNumber;
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    this.sink.writeRtp(rtp);
  }
}

export function forwardRtpToOutboundTracks(outboundTracks: Iterable<RtpOutboundTrack>, rtp: RtpPacket): void {
  for (const outbound of outboundTracks) {
    try {
      outbound.writeRtp(rtp.clone());
    } catch {
      // A dead subscriber is reaped on its connection-state change.
    }
  }
}

function* outboundTracksFor(
  subscribers: Iterable<Subscriber>,
  kind: "audio" | "video"
): Iterable<RtpOutboundTrack> {
  for (const subscriber of subscribers) {
    if (kind === "video" && !subscriber.ready) {
      continue;
    }
    const outbound = subscriber.forwarders.get(kind);
    if (outbound) {
      yield outbound;
    }
  }
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
/** Minimum spacing between PLIs relayed upstream, so a viewer storm cannot flood the publisher. */
const UPSTREAM_PLI_MIN_INTERVAL_MS = 500;

export class CoordinationServer {
  private readonly streams = new Map<string, StreamEntry>();
  private readonly ingestSessions = new Map<string, StreamEntry>();
  private readonly iceServers: RTCIceServer[];
  private readonly iceGatheringTimeoutMs: number;
  private readonly timer: Timer;

  constructor(options: CoordinationServerOptions = {}) {
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.iceGatheringTimeoutMs = options.iceGatheringTimeoutMs ?? 5000;
    this.timer = options.timer ?? defaultTimer;
  }

  /**
   * WHIP ingest: accept a publisher's SDP offer, wire its inbound track to
   * subscriber forwarding, and return the SDP answer + stream id.
   */
  async ingest(
    offerSdp: string,
    requestedStreamId?: string
  ): Promise<{ streamId: string; sessionId: string; answerSdp: string; etag: string }> {
    const streamId = requestedStreamId?.trim() || `stream-${randomUUID().slice(0, 8)}`;
    // Validate before allocating a peer connection. A malformed WHIP offer must
    // fail with 4xx without leaking a native transport.
    const iceCredentials = parseIceCredentials(offerSdp);

    const pc = new RTCPeerConnection({
      // Apply the operator's ICE servers to the ingest transport so a publisher
      // behind NAT can reach the server via TURN, not only the built-in STUN.
      iceServers: this.iceServers,
      bundlePolicy: "max-bundle",
      codecs: { video: [useH264({ parameters: `profile-level-id=${WEBRTC_H264_PROFILE_LEVEL_ID};packetization-mode=1;level-asymmetry-allowed=1` })], audio: [usePCMU()] },
    });
    const entry: StreamEntry = {
      streamId,
      ingestSessionId: randomUUID(),
      ingestPc: pc,
      inboundTracks: new Map(),
      subscribers: new Map(),
      createdAt: new Date().toISOString(),
      framesForwarded: 0,
      audioPacketsForwarded: 0,
      videoConfig: [],
      videoReplay: [],
      collectingKeyFrame: null,
      collectingKeyFrameTimestamp: null,
      videoReceiver: null,
      videoInboundSsrc: null,
      lastUpstreamPliMs: Number.NEGATIVE_INFINITY,
      iceEtag: randomUUID(),
      iceCredentials,
    };
    pc.onTrack.subscribe(track => {
      if (track.kind !== "audio" && track.kind !== "video") {
        return;
      }
      entry.inboundTracks.set(track.kind, track);
      if (track.kind === "video") {
        // Keep a handle on the ingest video receiver so a downstream WHEP PLI can
        // be relayed to the publisher (a keyframe request the publisher honors).
        entry.videoReceiver =
          pc.getTransceivers().find(transceiver => transceiver.receiver?.kind === "video")?.receiver ?? null;
      }
      track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
        if (track.kind === "video") {
          entry.videoInboundSsrc ??= rtp.header.ssrc;
          entry.framesForwarded += rtp.header.marker ? 1 : 0;
          this.cacheVideoForLateSubscriber(entry, rtp);
        } else {
          entry.audioPacketsForwarded++;
        }
        forwardRtpToOutboundTracks(outboundTracksFor(entry.subscribers.values(), track.kind), rtp);
      });
    });

    pc.connectionStateChange.subscribe(state => {
      // Only tear down the stream if THIS entry is the registered one. Guards a
      // pre-registration close (e.g. a failed replacement offer for an active id)
      // from stopping the existing healthy stream that still holds the id.
      //
      // A transient ICE `disconnected` is NOT terminal — it commonly recovers,
      // and tearing the stream down would close every WHEP viewer over a blip.
      // werift still advances to `failed` on a genuine, unrecovered failure.
      if ((state === "failed" || state === "closed") && this.streams.get(streamId) === entry) {
        void this.stopIngest(streamId);
      }
    });

    // Negotiate before registering the stream (or replacing an existing one), so
    // a malformed/unsupported offer that rejects here neither leaves a zombie
    // "connecting" entry in /api/streams nor tears down an already-healthy stream
    // that happens to share this id.
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitForIce(pc);
    } catch (error) {
      await pc.close().catch(() => {});
      throw error;
    }

    // Only now swap out any existing stream with this id. Migrate its live
    // subscribers to the new publisher session instead of closing them, so a
    // standard WHEP player survives a publisher reconnect; they re-initialize
    // from the new stream's next keyframe.
    const previous = this.streams.get(streamId);
    if (previous) {
      this.migrateSubscribers(previous, entry);
      await this.stopIngest(streamId);
    }
    this.streams.set(streamId, entry);
    this.ingestSessions.set(entry.ingestSessionId, entry);
    return {
      streamId,
      sessionId: entry.ingestSessionId,
      // Werift serializes rtcp-mux but not RFC 9725 / WHEP's required
      // rtcp-mux-only SDP attribute. This changes signalling only; the peer
      // connection remains RTCP-multiplexed.
      answerSdp: addRtcpMuxOnly(pc.localDescription?.sdp ?? ""),
      etag: entry.iceEtag,
    };
  }

  /**
   * WHEP subscribe: accept a browser's SDP offer, attach a forwarding track for
   * the requested stream, and return the SDP answer + subscriber id.
   */
  async subscribe(
    streamId: string,
    offerSdp: string
  ): Promise<{ subscriberId: string; answerSdp: string }> {
    const entry = this.streams.get(streamId);
    if (!entry) {
      throw new Error(`No such stream: ${streamId}`);
    }

    const pc = new RTCPeerConnection({
      // Give the subscriber transport the operator's ICE servers (TURN included)
      // so a remote browser can actually connect — not only via host/STUN
      // candidates on the server's private interface.
      iceServers: this.iceServers,
      bundlePolicy: "max-bundle",
      codecs: { video: [useH264({ parameters: `profile-level-id=${WEBRTC_H264_PROFILE_LEVEL_ID};packetization-mode=1;level-asymmetry-allowed=1` })], audio: [usePCMU()] },
    });
    const tracks = new Map<"audio" | "video", MediaStreamTrack>();
    const forwarders = new Map<"audio" | "video", SubscriberRtpForwarder>();
    const videoTrack = new MediaStreamTrack({ kind: "video" });
    tracks.set("video", videoTrack);
    forwarders.set("video", new SubscriberRtpForwarder(videoTrack));
    const videoTransceiver = pc.addTransceiver(videoTrack, { direction: "sendonly" });
    // A WHEP viewer that cannot decode (missing/late keyframe) sends a PLI. Relay
    // it to the publisher via the current entry for this id — resolving the id at
    // fire time so it follows the subscriber across a publisher reconnect.
    videoTransceiver.sender.onPictureLossIndication.subscribe(() => {
      const current = this.streams.get(streamId);
      if (current) {
        this.relayUpstreamPli(current);
      }
    });
    if (entry.inboundTracks.has("audio")) {
      const audioTrack = new MediaStreamTrack({ kind: "audio" });
      tracks.set("audio", audioTrack);
      forwarders.set("audio", new SubscriberRtpForwarder(audioTrack));
      pc.addTransceiver(audioTrack, { direction: "sendonly" });
    }

    const subscriberId = randomUUID();
    let replayArmed = false;
    const armReplayWhenConnected = (): void => {
      const subscriber = entry.subscribers.get(subscriberId);
      if (replayArmed || subscriber?.pc !== pc) {
        return;
      }
      replayArmed = true;
      this.armReplay(entry, subscriber);
    };
    const scheduleReplayWhenConnected = (): void => {
      // werift exposes `connected` before the remote WHEP peer has necessarily
      // installed the returned answer. Give the paired transport a short turn
      // to finish its sender/receiver bookkeeping before replaying cached RTP.
      this.timer.setTimeout(armReplayWhenConnected, 100);
    };

    pc.connectionStateChange.subscribe(state => {
      if (state === "connected") {
        scheduleReplayWhenConnected();
        return;
      }
      if (state === "failed" || state === "closed" || state === "disconnected") {
        // Resolve the current entry by id rather than the subscribe-time closure:
        // a publisher reconnect migrates this subscriber to a newer entry, and
        // deleting from the stale map would leak the peer connection.
        this.streams.get(streamId)?.subscribers.delete(subscriberId);
        void pc.close().catch(() => {});
      }
    });

    // Register the subscriber only after negotiation succeeds, so a malformed
    // WHEP offer that rejects here doesn't leave a phantom viewer in the
    // registry (with a live peer connection that RTP forwarding targets).
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitForIce(pc);
    } catch (error) {
      await pc.close().catch(() => {});
      throw error;
    }

    // The publisher may have stopped or replaced this stream while we were
    // awaiting negotiation/ICE. Registering on a stale entry would attach the
    // subscriber to a stream that stopIngest() already closed (so it never gets
    // RTP and can't be reached via stopSubscriber), leaking the peer connection.
    if (this.streams.get(streamId) !== entry) {
      await pc.close().catch(() => {});
      throw new Error(`Stream ${streamId} is no longer available`);
    }

    entry.subscribers.set(subscriberId, {
      id: subscriberId,
      pc,
      tracks,
      forwarders,
      ready: false,
      awaitingReplay: false,
    });
    // WHEP returns the answer before the browser can complete DTLS. Writing
    // before this connection is live is dropped by werift, so replay after the
    // connected transition (or immediately if it raced before registration).
    if (pc.connectionState === "connected") {
      scheduleReplayWhenConnected();
    }
    return { subscriberId, answerSdp: addRtcpMuxOnly(pc.localDescription?.sdp ?? "") };
  }

  async stopIngest(streamId: string): Promise<void> {
    const entry = this.streams.get(streamId);
    if (!entry) {
      return;
    }
    await this.stopIngestEntry(entry);
  }

  /** Stop the exact WHIP resource identified by its opaque session id. */
  async stopIngestSession(sessionId: string): Promise<void> {
    const entry = this.ingestSessions.get(sessionId);
    if (entry) {
      await this.stopIngestEntry(entry);
    }
  }

  private async stopIngestEntry(entry: StreamEntry): Promise<void> {
    if (this.streams.get(entry.streamId) === entry) {
      this.streams.delete(entry.streamId);
    }
    this.ingestSessions.delete(entry.ingestSessionId);
    for (const subscriber of entry.subscribers.values()) {
      await subscriber.pc.close().catch(() => {});
    }
    await entry.ingestPc.close().catch(() => {});
  }

  /**
   * Move live subscribers from a superseded publisher session onto its
   * replacement, and re-arm replay so each is re-initialized from the new
   * stream's next keyframe. Clearing the source map means the subsequent
   * `stopIngest` of the old entry closes only its ingest peer connection.
   */
  private migrateSubscribers(from: StreamEntry, to: StreamEntry): void {
    for (const [subscriberId, subscriber] of from.subscribers) {
      to.subscribers.set(subscriberId, subscriber);
      subscriber.ready = false;
      this.armReplay(to, subscriber);
    }
    from.subscribers.clear();
  }

  /**
   * Apply trickle-ICE candidates (WHIP PATCH, `application/trickle-ice-sdpfrag`)
   * from the publisher to the ingest peer connection. Returns false when the
   * stream id is unknown so the HTTP layer can answer 404. Parses leniently: the
   * `a=mid:` line (if any) applies to the following `a=candidate:` lines.
   */
  getIceEtag(sessionId: string): string | null {
    return this.ingestSessions.get(sessionId)?.iceEtag ?? null;
  }

  async addIngestCandidates(sessionId: string, fragment: string): Promise<"unknown" | "applied" | "invalid" | "restart"> {
    const entry = this.ingestSessions.get(sessionId);
    if (!entry) {
      return "unknown";
    }
    const parsed = parseCandidateFragment(fragment);
    if (!parsed) {
      return "invalid";
    }
    if (parsed.ice.ufrag !== entry.iceCredentials.ufrag || parsed.ice.pwd !== entry.iceCredentials.pwd) {
      return "restart";
    }
    for (const candidate of parsed.candidates) {
      await entry.ingestPc
        .addIceCandidate({ candidate, sdpMid: parsed.mid })
        .catch(() => {
          // A malformed or duplicate candidate is non-fatal; keep the stream up.
        });
    }
    return "applied";
  }

  async stopSubscriber(streamId: string, subscriberId: string): Promise<void> {
    const entry = this.streams.get(streamId);
    const subscriber = entry?.subscribers.get(subscriberId);
    if (!entry || !subscriber) {
      return;
    }
    entry.subscribers.delete(subscriberId);
    await subscriber.pc.close().catch(() => {});
  }

  listStreams(): StreamDescriptor[] {
    return Array.from(this.streams.values()).map(entry => this.describe(entry));
  }

  getStream(streamId: string): StreamDescriptor | null {
    const entry = this.streams.get(streamId);
    return entry ? this.describe(entry) : null;
  }

  async close(): Promise<void> {
    for (const streamId of Array.from(this.streams.keys())) {
      await this.stopIngest(streamId);
    }
  }

  private describe(entry: StreamEntry): StreamDescriptor {
    return {
      streamId: entry.streamId,
      state: entry.inboundTracks.has("video") ? "live" : "connecting",
      subscriberCount: entry.subscribers.size,
      createdAt: entry.createdAt,
      // Encode so an id with a path separator (e.g. a CI ref "feature/foo")
      // stays a single URL path segment the WHEP route can match.
      whepUrl: `/whep/${encodeURIComponent(entry.streamId)}`,
      iceServers: this.iceServers,
      framesForwarded: entry.framesForwarded,
      audio: entry.inboundTracks.has("audio"),
      audioPacketsForwarded: entry.audioPacketsForwarded,
    };
  }

  /**
   * Cache the newest SPS/PPS and, when a full IDR access unit completes, snapshot
   * it together with those parameter sets so a late viewer receives a consistent
   * decoder-init sequence. Replays immediately to any subscriber that was waiting
   * for a keyframe.
   */
  private cacheVideoForLateSubscriber(entry: StreamEntry, rtp: RtpPacket): void {
    const payload = rtp.payload;
    const nalType = payload[0] & 0x1f;
    // SPS/PPS are normally single RTP packets. Preserve the most recent pair so a
    // new decoder can configure itself before its first IDR access unit. RFC 6184
    // §8 documents parameter-set transport; caching/replay is our late-viewer
    // policy, not a replacement for RTCP feedback.
    // https://www.rfc-editor.org/rfc/rfc6184.html#section-8
    if (nalType === 7 || nalType === 8 || containsStapANalType(payload, 7) || containsStapANalType(payload, 8)) {
      entry.videoConfig = [...entry.videoConfig.filter(packet => (packet.payload[0] & 0x1f) !== nalType), rtp.clone()];
    }

    const isIdrStart = nalType === 5 || (nalType === 28 && (payload[1] & 0x80) !== 0 && (payload[1] & 0x1f) === 5) || containsStapANalType(payload, 5);
    // An IDR access unit may contain several type-5 NALs (or fragmented FU-As).
    // Keep collecting until its RTP marker rather than discarding earlier slices.
    if (isIdrStart && (!entry.collectingKeyFrame || entry.collectingKeyFrameTimestamp !== rtp.header.timestamp)) {
      entry.collectingKeyFrame = [];
      entry.collectingKeyFrameTimestamp = rtp.header.timestamp;
    }
    if (entry.collectingKeyFrame) {
      entry.collectingKeyFrame.push(rtp.clone());
      if (rtp.header.marker) {
        const accessUnit = entry.collectingKeyFrame;
        entry.collectingKeyFrame = null;
        entry.collectingKeyFrameTimestamp = null;
        // Snapshot config + IDR atomically. If the IDR access unit already carries
        // its own parameter sets in-band (publisher re-injection), don't prepend
        // the standalone cache — sending SPS/PPS twice is wasteful (though
        // decoders tolerate it).
        entry.videoReplay = accessUnitCarriesParameterSets(accessUnit)
          ? accessUnit
          : [...entry.videoConfig, ...accessUnit];
        for (const subscriber of entry.subscribers.values()) {
          if (subscriber.awaitingReplay) {
            this.deliverReplay(entry, subscriber);
          }
        }
      }
    }
  }

  /**
   * Begin serving a subscriber: replay the cached keyframe now if one exists,
   * otherwise defer until the stream's next keyframe completes.
   */
  private armReplay(entry: StreamEntry, subscriber: Subscriber): void {
    if (entry.videoReplay.length > 0) {
      this.deliverReplay(entry, subscriber);
    } else {
      // No keyframe yet: forwarding live P-frames would be undecodable. Wait for
      // the next IDR, and nudge the publisher to produce one promptly.
      subscriber.awaitingReplay = true;
      this.relayUpstreamPli(entry);
    }
  }

  /** Replay the cached keyframe to a subscriber, then open the live video gate. */
  private deliverReplay(entry: StreamEntry, subscriber: Subscriber): void {
    subscriber.awaitingReplay = false;
    const forwarder = subscriber.forwarders.get("video");
    if (forwarder) {
      for (const packet of entry.videoReplay) {
        try {
          forwarder.writeRtp(packet.clone());
        } catch {
          break;
        }
      }
    }
    subscriber.ready = true;
    // Ask the publisher for a fresh IDR so the viewer recovers quickly if the
    // live P-frames that follow reference frames it never received.
    this.relayUpstreamPli(entry);
  }

  /** Relay a keyframe request to the publisher, throttled to avoid a storm. */
  private relayUpstreamPli(entry: StreamEntry): void {
    const receiver = entry.videoReceiver;
    const ssrc = entry.videoInboundSsrc;
    if (!receiver || ssrc === null) {
      return;
    }
    const now = this.timer.now();
    if (now - entry.lastUpstreamPliMs < UPSTREAM_PLI_MIN_INTERVAL_MS) {
      return;
    }
    entry.lastUpstreamPliMs = now;
    void receiver.sendRtcpPLI(ssrc).catch(() => {
      // Best-effort: a closed/reconnecting transport just misses this request;
      // the next periodic IDR still recovers the viewer.
    });
  }

  private async waitForIce(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") {
      return;
    }
    try {
      await pc.iceGatheringStateChange.watch(
        state => state === "complete",
        this.iceGatheringTimeoutMs
      );
    } catch {
      // Proceed with whatever candidates were gathered.
    }
  }
}

function addRtcpMuxOnly(sdp: string): string {
  return sdp.replace(/a=rtcp-mux\r?\n/g, match => `${match}a=rtcp-mux-only\r\n`);
}

/** True if an access unit already contains SPS or PPS NALs (single or STAP-A). */
function accessUnitCarriesParameterSets(accessUnit: RtpPacket[]): boolean {
  return accessUnit.some(packet => {
    const nalType = packet.payload[0] & 0x1f;
    return (
      nalType === 7 ||
      nalType === 8 ||
      containsStapANalType(packet.payload, 7) ||
      containsStapANalType(packet.payload, 8)
    );
  });
}

function containsStapANalType(payload: Buffer, expectedType: number): boolean {
  if ((payload[0] & 0x1f) !== 24) {return false;}
  let offset = 1;
  while (offset + 2 <= payload.length) {
    const size = payload.readUInt16BE(offset);
    offset += 2;
    if (size === 0 || offset + size > payload.length) {return false;}
    if ((payload[offset] & 0x1f) === expectedType) {return true;}
    offset += size;
  }
  return false;
}

function parseIceCredentials(sdp: string): { ufrag: string; pwd: string } {
  const ufrag = sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1]?.trim();
  const pwd = sdp.match(/^a=ice-pwd:(.+)$/m)?.[1]?.trim();
  if (!ufrag || !pwd) {throw new Error("Offer omitted ICE credentials.");}
  return { ufrag, pwd };
}

function parseCandidateFragment(fragment: string): { mid: string; ice: { ufrag: string; pwd: string }; candidates: string[] } | null {
  const lines = fragment.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const mLine = lines.find(line => line.startsWith("m="));
  const mid = lines.find(line => line.startsWith("a=mid:"))?.slice(6).trim();
  const ufrag = lines.find(line => line.startsWith("a=ice-ufrag:"))?.slice(12).trim();
  const pwd = lines.find(line => line.startsWith("a=ice-pwd:"))?.slice(10).trim();
  const candidates = lines.filter(line => line.startsWith("a=candidate:")).map(line => line.slice(2));
  if (!mLine || !mid || !ufrag || !pwd || (candidates.length === 0 && !lines.includes("a=end-of-candidates"))) {return null;}
  return { mid, ice: { ufrag, pwd }, candidates };
}
