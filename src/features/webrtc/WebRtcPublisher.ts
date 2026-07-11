import {
  MediaStreamTrack,
  RTCPeerConnection,
  useH264,
  type RTCIceServer,
} from "werift";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { BackoffInput } from "../../utils/Backoff";
import { DEFAULT_RTP_MTU } from "./h264";
import { ReconnectController, type ReconnectState } from "./ReconnectController";
import { RtpH264TrackWriter } from "./RtpH264TrackWriter";
import { WhipClient, type WhipClientOptions } from "./WhipClient";

/** How long to wait for ICE gathering before publishing the offer. */
export const ICE_GATHERING_TIMEOUT_MS = 5000;

export interface WebRtcPublisherConfig {
  /** Stable identifier for this stream (also useful to the coordination server). */
  streamId: string;
  whipEndpoint: string;
  bearerToken?: string;
  iceServers?: RTCIceServer[];
  bitrateBps?: number;
  mtu?: number;
  maxReconnectAttempts?: number;
  reconnectBackoff?: BackoffInput;
}

export interface WebRtcPublisherDeps {
  /** Factory for peer connections (injectable for tests). */
  createPeerConnection?: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  /** Factory for the WHIP client (injectable for tests). */
  createWhipClient?: (options: WhipClientOptions) => WhipClient;
  timer?: Timer;
  /**
   * Called at the start of each (re)establish, before the offer is built. The
   * manager uses this to (re)start the capture source so a fresh SPS/PPS + IDR
   * follows a reconnect and the receiver can decode immediately.
   */
  onBeforeEstablish?: () => Promise<void> | void;
  onStateChange?: (state: ReconnectState) => void;
}

/** Reconnect descriptor surfaced to callers and the coordination-server API. */
export interface WebRtcStreamDescriptor {
  streamId: string;
  state: ReconnectState;
  whipEndpoint: string;
  /** WHIP resource URL for the active session (used to reconnect / tear down). */
  resourceUrl: string | null;
  iceServers: RTCIceServer[];
  framesSent: number;
  packetsSent: number;
}

/**
 * Publishes a live H.264 stream to a coordination server over WHIP using werift.
 * Feed the raw Annex-B elementary stream via {@link writeH264Chunk}; the
 * publisher packetizes it to RTP and sends it over a sendonly WebRTC track.
 * Connection loss triggers automatic reconnection (fresh WHIP publish) with
 * backoff via {@link ReconnectController}.
 */
export class WebRtcPublisher {
  private readonly config: WebRtcPublisherConfig;
  private readonly createPeerConnection: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  private readonly whip: WhipClient;
  private readonly timer: Timer;
  private readonly onBeforeEstablish?: () => Promise<void> | void;
  private readonly controller: ReconnectController;

  private pc: RTCPeerConnection | null = null;
  private writer: RtpH264TrackWriter | null = null;
  private resourceUrl: string | null = null;
  private state: ReconnectState = "idle";
  private closed = false;
  private establishing = false;

  constructor(config: WebRtcPublisherConfig, deps: WebRtcPublisherDeps = {}) {
    this.config = config;
    this.timer = deps.timer ?? defaultTimer;
    this.onBeforeEstablish = deps.onBeforeEstablish;
    this.createPeerConnection =
      deps.createPeerConnection ??
      (iceServers =>
        new RTCPeerConnection({
          iceServers,
          codecs: { video: [useH264()] },
        }));
    const createWhip = deps.createWhipClient ?? (options => new WhipClient(options));
    this.whip = createWhip({
      endpoint: config.whipEndpoint,
      bearerToken: config.bearerToken,
    });
    this.controller = new ReconnectController({
      attempt: () => this.establish(),
      backoff: config.reconnectBackoff,
      maxAttempts: config.maxReconnectAttempts,
      timer: this.timer,
      onStateChange: state => {
        this.state = state;
        deps.onStateChange?.(state);
      },
    });
  }

  /** Begin publishing. Resolves once the first WHIP publish settles. */
  async start(): Promise<void> {
    if (this.closed) {
      throw new Error("Publisher already closed.");
    }
    await this.controller.start();
  }

  /** Feed a chunk of the raw H.264 (Annex-B) elementary stream. */
  writeH264Chunk(chunk: Buffer): void {
    this.writer?.writeChunk(chunk);
  }

  getState(): ReconnectState {
    return this.state;
  }

  getDescriptor(): WebRtcStreamDescriptor {
    const stats = this.writer?.stats;
    return {
      streamId: this.config.streamId,
      state: this.state,
      whipEndpoint: this.config.whipEndpoint,
      resourceUrl: this.resourceUrl,
      iceServers: this.config.iceServers ?? [],
      framesSent: stats?.framesWritten ?? 0,
      packetsSent: stats?.packetsWritten ?? 0,
    };
  }

  /** Stop publishing and release the peer connection + ingest resource. */
  async stop(): Promise<void> {
    this.closed = true;
    this.controller.stop();
    await this.teardownActiveSession();
  }

  private async establish(): Promise<void> {
    if (this.closed) {
      throw new Error("Publisher closed.");
    }
    this.establishing = true;
    // Discard any prior session before building a new one.
    await this.teardownActiveSession();

    await this.onBeforeEstablish?.();

    const pc = this.createPeerConnection(this.config.iceServers ?? []);
    this.pc = pc;

    const track = new MediaStreamTrack({ kind: "video" });
    const transceiver = pc.addTransceiver(track, { direction: "sendonly" });
    this.writer = new RtpH264TrackWriter({
      sink: track,
      ssrc: transceiver.sender.ssrc,
      mtu: this.config.mtu ?? DEFAULT_RTP_MTU,
      timer: this.timer,
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) {
      throw new Error("Failed to produce a local SDP offer.");
    }

    const session = await this.whip.publish(localSdp);
    this.resourceUrl = session.resourceUrl;
    await pc.setRemoteDescription({ type: "answer", sdp: session.answerSdp });

    this.establishing = false;
    this.watchConnectionState(pc);
    logger.info(
      `[WebRTC] stream ${this.config.streamId} published to ${this.config.whipEndpoint}` +
        (session.resourceUrl ? ` (resource ${session.resourceUrl})` : "")
    );
  }

  private watchConnectionState(pc: RTCPeerConnection): void {
    pc.connectionStateChange.subscribe(state => {
      if (this.closed || this.pc !== pc || this.establishing) {
        return;
      }
      if (state === "failed" || state === "disconnected") {
        logger.warn(`[WebRTC] stream ${this.config.streamId} connection ${state}; reconnecting`);
        this.controller.notifyConnectionLost();
      }
    });
  }

  private async waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") {
      return;
    }
    try {
      await pc.iceGatheringStateChange.watch(
        state => state === "complete",
        ICE_GATHERING_TIMEOUT_MS
      );
    } catch {
      // Timed out — proceed with whatever candidates gathered so far. Non-trickle
      // WHIP servers still often connect via the host/srflx candidates present.
      logger.warn(`[WebRTC] ICE gathering did not complete within ${ICE_GATHERING_TIMEOUT_MS}ms; publishing partial offer`);
    }
  }

  private async teardownActiveSession(): Promise<void> {
    const pc = this.pc;
    const resourceUrl = this.resourceUrl;
    this.pc = null;
    this.writer = null;
    this.resourceUrl = null;

    if (resourceUrl) {
      try {
        await this.whip.delete(resourceUrl);
      } catch (error) {
        logger.debug(`[WebRTC] WHIP delete failed during teardown: ${error}`);
      }
    }
    if (pc) {
      try {
        await pc.close();
      } catch (error) {
        logger.debug(`[WebRTC] peer close failed during teardown: ${error}`);
      }
    }
  }
}
