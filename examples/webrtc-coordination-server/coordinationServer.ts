import { randomUUID } from "node:crypto";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpPacket,
  useH264,
  type RTCIceServer,
} from "werift";

/**
 * Reference WebRTC coordination server (a tiny SFU).
 *
 * AutoMobile publishers push H.264 to `ingest()` over WHIP; browsers pull the
 * same stream from `subscribe()` over WHEP. Incoming RTP is forwarded to every
 * subscriber of that stream. `listStreams()` / `getStream()` back the reconnect
 * API a frontend uses to discover streams and (re)connect.
 *
 * This is intentionally minimal (single-server, in-memory) — for production use
 * a hardened SFU such as MediaMTX, LiveKit, or Janus that also speaks WHIP/WHEP.
 */

export interface CoordinationServerOptions {
  /** ICE servers advertised to WHEP subscribers and surfaced in the reconnect API. */
  iceServers?: RTCIceServer[];
  /** How long to wait for ICE gathering (ms) before returning an SDP answer. */
  iceGatheringTimeoutMs?: number;
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
}

interface Subscriber {
  id: string;
  pc: RTCPeerConnection;
  track: MediaStreamTrack;
}

interface StreamEntry {
  streamId: string;
  ingestPc: RTCPeerConnection;
  inboundTrack: MediaStreamTrack | null;
  subscribers: Map<string, Subscriber>;
  createdAt: string;
  framesForwarded: number;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export class CoordinationServer {
  private readonly streams = new Map<string, StreamEntry>();
  private readonly iceServers: RTCIceServer[];
  private readonly iceGatheringTimeoutMs: number;

  constructor(options: CoordinationServerOptions = {}) {
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.iceGatheringTimeoutMs = options.iceGatheringTimeoutMs ?? 5000;
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
    if (this.streams.has(streamId)) {
      await this.stopIngest(streamId);
    }

    const pc = new RTCPeerConnection({ codecs: { video: [useH264()] } });
    const entry: StreamEntry = {
      streamId,
      ingestPc: pc,
      inboundTrack: null,
      subscribers: new Map(),
      createdAt: new Date().toISOString(),
      framesForwarded: 0,
    };
    this.streams.set(streamId, entry);

    pc.onTrack.subscribe(track => {
      entry.inboundTrack = track;
      track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
        entry.framesForwarded += rtp.header.marker ? 1 : 0;
        for (const subscriber of entry.subscribers.values()) {
          try {
            subscriber.track.writeRtp(rtp);
          } catch {
            // A dead subscriber is reaped on its connection-state change.
          }
        }
      });
    });

    pc.connectionStateChange.subscribe(state => {
      if (state === "failed" || state === "closed" || state === "disconnected") {
        void this.stopIngest(streamId);
      }
    });

    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForIce(pc);

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

    const pc = new RTCPeerConnection({ codecs: { video: [useH264()] } });
    const track = new MediaStreamTrack({ kind: "video" });
    pc.addTransceiver(track, { direction: "sendonly" });

    const subscriberId = randomUUID();
    const subscriber: Subscriber = { id: subscriberId, pc, track };
    entry.subscribers.set(subscriberId, subscriber);

    pc.connectionStateChange.subscribe(state => {
      if (state === "failed" || state === "closed" || state === "disconnected") {
        entry.subscribers.delete(subscriberId);
        void pc.close().catch(() => {});
      }
    });

    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForIce(pc);

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
      state: entry.inboundTrack ? "live" : "connecting",
      subscriberCount: entry.subscribers.size,
      createdAt: entry.createdAt,
      whepUrl: `/whep/${entry.streamId}`,
      iceServers: this.iceServers,
      framesForwarded: entry.framesForwarded,
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
