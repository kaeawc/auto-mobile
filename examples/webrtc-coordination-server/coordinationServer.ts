import { randomUUID } from "node:crypto";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpPacket,
  useH264,
  usePCMU,
  type RTCIceServer,
} from "werift";
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
}

interface StreamEntry {
  streamId: string;
  ingestPc: RTCPeerConnection;
  inboundTracks: Map<"audio" | "video", MediaStreamTrack>;
  subscribers: Map<string, Subscriber>;
  createdAt: string;
  framesForwarded: number;
  audioPacketsForwarded: number;
  /** Last codec config plus a complete IDR access unit for late WHEP viewers. */
  videoConfig: RtpPacket[];
  videoKeyFrame: RtpPacket[];
  collectingKeyFrame: RtpPacket[] | null;
}

export interface RtpOutboundTrack {
  writeRtp(rtp: RtpPacket): void;
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
    const outbound = subscriber.tracks.get(kind);
    if (outbound) {
      yield outbound;
    }
  }
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export class CoordinationServer {
  private readonly streams = new Map<string, StreamEntry>();
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
  ): Promise<{ streamId: string; answerSdp: string }> {
    const streamId = requestedStreamId?.trim() || `stream-${randomUUID().slice(0, 8)}`;

    const pc = new RTCPeerConnection({ codecs: { video: [useH264()], audio: [usePCMU()] } });
    const entry: StreamEntry = {
      streamId,
      ingestPc: pc,
      inboundTracks: new Map(),
      subscribers: new Map(),
      createdAt: new Date().toISOString(),
      framesForwarded: 0,
      audioPacketsForwarded: 0,
      videoConfig: [],
      videoKeyFrame: [],
      collectingKeyFrame: null,
    };
    pc.onTrack.subscribe(track => {
      if (track.kind !== "audio" && track.kind !== "video") {
        return;
      }
      entry.inboundTracks.set(track.kind, track);
      track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
        if (track.kind === "video") {
          entry.framesForwarded += rtp.header.marker ? 1 : 0;
          cacheVideoForLateSubscriber(entry, rtp);
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
      if (
        (state === "failed" || state === "closed" || state === "disconnected") &&
        this.streams.get(streamId) === entry
      ) {
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

    // Only now swap out any existing stream with this id.
    if (this.streams.has(streamId)) {
      await this.stopIngest(streamId);
    }
    this.streams.set(streamId, entry);
    return { streamId, answerSdp: pc.localDescription?.sdp ?? "" };
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

    const pc = new RTCPeerConnection({ codecs: { video: [useH264()], audio: [usePCMU()] } });
    const tracks = new Map<"audio" | "video", MediaStreamTrack>();
    const videoTrack = new MediaStreamTrack({ kind: "video" });
    tracks.set("video", videoTrack);
    pc.addTransceiver(videoTrack, { direction: "sendonly" });
    if (entry.inboundTracks.has("audio")) {
      const audioTrack = new MediaStreamTrack({ kind: "audio" });
      tracks.set("audio", audioTrack);
      pc.addTransceiver(audioTrack, { direction: "sendonly" });
    }

    const subscriberId = randomUUID();
    let replayedCachedVideo = false;
    const replayWhenConnected = (): void => {
      if (replayedCachedVideo || entry.subscribers.get(subscriberId)?.pc !== pc) {
        return;
      }
      replayedCachedVideo = true;
      replayCachedVideo(entry, videoTrack);
    };
    const scheduleReplayWhenConnected = (): void => {
      // werift exposes `connected` before the remote WHEP peer has necessarily
      // installed the returned answer. Give the paired transport a short turn
      // to finish its sender/receiver bookkeeping before replaying cached RTP.
      this.timer.setTimeout(replayWhenConnected, 100);
    };

    pc.connectionStateChange.subscribe(state => {
      if (state === "connected") {
        scheduleReplayWhenConnected();
        return;
      }
      if (state === "failed" || state === "closed" || state === "disconnected") {
        entry.subscribers.delete(subscriberId);
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

    entry.subscribers.set(subscriberId, { id: subscriberId, pc, tracks });
    // WHEP returns the answer before the browser can complete DTLS. Writing
    // before this connection is live is dropped by werift, so replay after the
    // connected transition (or immediately if it raced before registration).
    if (pc.connectionState === "connected") {
      scheduleReplayWhenConnected();
    }
    return { subscriberId, answerSdp: pc.localDescription?.sdp ?? "" };
  }

  async stopIngest(streamId: string): Promise<void> {
    const entry = this.streams.get(streamId);
    if (!entry) {
      return;
    }
    this.streams.delete(streamId);
    for (const subscriber of entry.subscribers.values()) {
      await subscriber.pc.close().catch(() => {});
    }
    await entry.ingestPc.close().catch(() => {});
  }

  /**
   * Apply trickle-ICE candidates (WHIP PATCH, `application/trickle-ice-sdpfrag`)
   * from the publisher to the ingest peer connection. Returns false when the
   * stream id is unknown so the HTTP layer can answer 404. Parses leniently: the
   * `a=mid:` line (if any) applies to the following `a=candidate:` lines.
   */
  async addIngestCandidates(streamId: string, fragment: string): Promise<boolean> {
    const entry = this.streams.get(streamId);
    if (!entry) {
      return false;
    }
    let sdpMid: string | undefined;
    for (const rawLine of fragment.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("a=mid:")) {
        sdpMid = line.slice("a=mid:".length).trim() || undefined;
      } else if (line.startsWith("a=candidate:")) {
        await entry.ingestPc
          .addIceCandidate({ candidate: line.slice("a=".length), sdpMid })
          .catch(() => {
            // A malformed or duplicate candidate is non-fatal; keep the stream up.
          });
      }
    }
    return true;
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

function cacheVideoForLateSubscriber(entry: StreamEntry, rtp: RtpPacket): void {
  const payload = rtp.payload;
  const nalType = payload[0] & 0x1f;
  // SPS/PPS are normally single RTP packets. Preserve the most recent pair so a
  // new decoder can configure itself before its first IDR access unit. RFC 6184
  // §8 documents parameter-set transport; caching/replay is our late-viewer
  // policy, not a replacement for RTCP feedback.
  // https://www.rfc-editor.org/rfc/rfc6184.html#section-8
  if (nalType === 7 || nalType === 8) {
    entry.videoConfig = [...entry.videoConfig.filter(packet => (packet.payload[0] & 0x1f) !== nalType), rtp.clone()];
  }

  const isIdrStart = nalType === 5 || (nalType === 28 && (payload[1] & 0x80) !== 0 && (payload[1] & 0x1f) === 5);
  // An IDR access unit may contain several type-5 NALs (or fragmented FU-As).
  // Keep collecting until its RTP marker rather than discarding earlier slices.
  if (isIdrStart && !entry.collectingKeyFrame) {entry.collectingKeyFrame = [];}
  if (entry.collectingKeyFrame) {
    entry.collectingKeyFrame.push(rtp.clone());
    if (rtp.header.marker) {
      entry.videoKeyFrame = entry.collectingKeyFrame;
      entry.collectingKeyFrame = null;
    }
  }
}

function replayCachedVideo(entry: StreamEntry, track: MediaStreamTrack): void {
  for (const packet of [...entry.videoConfig, ...entry.videoKeyFrame]) {
    try {
      track.writeRtp(packet.clone());
    } catch {
      return;
    }
  }
}
