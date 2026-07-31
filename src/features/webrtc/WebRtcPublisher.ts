import {
  MediaStreamTrack,
  RTCPeerConnection,
  useH264,
  usePCMU,
  type RTCIceServer,
} from "werift";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { BackoffInput } from "../../utils/Backoff";
import { DEFAULT_RTP_MTU } from "./h264";
import { ReconnectController, type ReconnectState } from "./ReconnectController";
import { RtpH264TrackWriter } from "./RtpH264TrackWriter";
import { RtpPcmuTrackWriter } from "./RtpPcmuTrackWriter";
import {
  evaluateH264SpsForSend,
  isCompatibleConstrainedBaselineProfile,
  WEBRTC_H264_LEVEL_IDC,
  WEBRTC_H264_PROFILE_LEVEL_ID,
} from "./h264Level";
import { parseTrickleIceMediaContexts, TrickleIceForwarder } from "./trickleIce";
import { WhipClient, type WhipClientOptions } from "./WhipClient";
import type { H264CaptureSourceMetrics } from "./H264CaptureSource";

/**
 * How long to wait for ICE gathering before publishing the offer.
 *
 * Protocol background: [ICE (RFC 8445)](https://www.rfc-editor.org/rfc/rfc8445.html).
 * AutoMobile's bounded non-trickle wait is an implementation choice; enable
 * `trickleIce` for the WHIP extension described in `trickleIce.ts`.
 */
export const ICE_GATHERING_TIMEOUT_MS = 5000;

/**
 * Minimum spacing between keyframe requests forwarded to the capture source.
 * A burst of viewer PLIs (e.g. several browsers joining at once) collapses to at
 * most one IDR request per interval so the encoder is not thrashed.
 */
export const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 1000;

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
  /**
   * Use trickle ICE: publish the offer immediately and PATCH local candidates
   * as they gather, instead of blocking on ICE gathering. Requires an ingest
   * server that supports the WHIP trickle extension. Defaults to false.
   */
  trickleIce?: boolean;
  /** Add a sendonly PCMU audio track alongside video. Defaults to false. */
  audioEnabled?: boolean;
  /**
   * If set (> 0), while the connection is `connected` the publisher watches for
   * the frame counter to stop advancing. A source that stays alive but stops
   * producing frames (a wedged encoder, a frozen capture helper) does not change
   * the peer `connectionState`, so without this the viewer sits on a frozen frame
   * forever. On a stall the publisher routes through the reconnect path. Disabled
   * when unset.
   */
  frameStallTimeoutMs?: number;
}

export interface WebRtcPublisherDeps {
  /** Factory for peer connections (injectable for tests). */
  createPeerConnection?: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  /** Factory for the WHIP client (injectable for tests). */
  createWhipClient?: (options: WhipClientOptions) => WhipClient;
  timer?: Timer;
  /**
   * Called at the start of each (re)establish, before the offer is built. The
   * manager uses this to recreate capture only after a capture failure. A normal
   * WHIP/ICE reconnect keeps the prepared encoder or helper alive.
   */
  onBeforeEstablish?: () => Promise<void> | void;
  /**
   * Called once the peer connection reaches `connected`. The manager uses this
   * to mark publishing readiness and request a fresh IDR from its already-warm
   * capture source.
   */
  onConnected?: () => Promise<void> | void;
  /**
   * Called when the remote (coordination server, relaying a WHEP viewer's PLI)
   * requests a keyframe. The manager forwards it to the capture source so the
   * encoder emits a fresh IDR, letting a late or recovering viewer decode
   * without waiting for the periodic IDR interval. Throttled by the publisher.
   */
  onKeyFrameRequest?: () => boolean;
  /**
   * Called when packetization rejects source media after H.264 capability
   * validation. The manager must expose the failure and recreate capture for
   * the reconnect instead of reporting a healthy publisher with no usable RTP.
   */
  onSourceFailure?: (error: Error) => void;
  onStateChange?: (state: ReconnectState) => void;
  /** Significant publish milestones, owned by the stream coordinator for telemetry. */
  onLifecycleEvent?: (event: WebRtcPublisherLifecycleEvent) => void;
}

export type WebRtcCaptureSourceState =
  | "not_initialized"
  | "starting"
  | "running"
  | "failed"
  | "stopped";

/**
 * Readiness observations exposed through the stream coordinator's status API.
 * Timestamp and counter fields use `null` until their producer is initialized,
 * avoiding ambiguity between absent data and a measured zero.
 */
export interface WebRtcStreamReadiness {
  lastEncodedFrameTimestampUs: number | null;
  lastIdrTimestampUs: number | null;
  idrRequestCount: number | null;
  idrCompletionCount: number | null;
  encodedAccessUnitCount: number | null;
  publisherRtpPacketCount: number | null;
  captureSourceState: WebRtcCaptureSourceState;
  lastSourceError: string | null;
}

export type WebRtcPublisherLifecycleEvent =
  | "sdp_offer_created"
  | "ice_gathering_started"
  | "ice_gathering_complete"
  | "ice_gathering_timeout"
  | "whip_answer_received"
  | "ice_connected"
  | "first_rtp_sent";

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
  audioPacketsSent: number;
  audioSamplesSent: number;
  readiness: WebRtcStreamReadiness;
  /**
   * True once the manager-owned capture source is prepared. `state` alone
   * cannot tell "WHIP publish accepted" from "capture running", so the manager
   * surfaces this independently; absent on descriptors the publisher builds on
   * its own.
   */
  sourceStarted?: boolean;
  /** Latest capture-pipeline metrics, when supplied by the active source. */
  frameMetrics?: H264CaptureSourceMetrics;
  /** Coordinator lifecycle, including capture preparation before WHIP publish. */
  lifecycleState?:
    | "idle"
    | "preparing"
    | "capture_ready"
    | "publishing"
    | "degraded"
    | "stopping"
    | "failed";
  /** Stable failure code for a caller that must fall back to screenshots. */
  failure?: { code: string; message: string; at: string } | null;
  /** Capture and publish milestones used to attribute cold-start delay. */
  telemetry?: {
    requestReceived: string;
    captureSourcePrepared?: string;
    firstMediaFrame?: string;
    firstIdr?: string;
    sdpOffer?: string;
    sdpAnswer?: string;
    iceConnected?: string;
    firstRtpSent?: string;
    nonTrickleIceGatheringDelayMs?: number;
  };
  /** Capture can no longer serve video; callers should use screenshot observation. */
  fallback?: { mode: "screenshots"; reason: string } | null;
  /** Lease returned to the control-plane caller that started or renewed this stream. */
  lease?: { id: string; expiresAt: string } | null;
  /** Number of active control-plane leases retaining this capture source. */
  consumerCount?: number;
}

/**
 * Publishes a live H.264 stream to a coordination server over WHIP using werift.
 * Feed the raw Annex-B elementary stream via {@link writeH264Chunk}; the
 * publisher packetizes it to RTP and sends it over a sendonly WebRTC track.
 * Connection loss triggers automatic reconnection (fresh WHIP publish) with
 * backoff via {@link ReconnectController}.
 *
 * Standards: [W3C WebRTC](https://www.w3.org/TR/webrtc/),
 * [JSEP (RFC 9429)](https://www.rfc-editor.org/rfc/rfc9429.html),
 * [WHIP (RFC 9725)](https://www.rfc-editor.org/rfc/rfc9725.html), and
 * [H.264 over RTP (RFC 6184)](https://www.rfc-editor.org/rfc/rfc6184.html).
 * See `docs/design-docs/mcp/observe/webrtc-standards-map.md` for the full
 * implementation-to-spec mapping.
 */
export class WebRtcPublisher {
  private readonly config: WebRtcPublisherConfig;
  private readonly createPeerConnection: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  private readonly whip: WhipClient;
  private readonly timer: Timer;
  private readonly onBeforeEstablish?: () => Promise<void> | void;
  private readonly onConnected?: () => Promise<void> | void;
  private readonly onKeyFrameRequest?: () => boolean;
  private readonly onSourceFailure?: (error: Error) => void;
  private readonly onLifecycleEvent?: (event: WebRtcPublisherLifecycleEvent) => void;
  private readonly controller: ReconnectController;

  private readonly trickleIce: boolean;
  private readonly audioEnabled: boolean;

  private pc: RTCPeerConnection | null = null;
  private writer: RtpH264TrackWriter | null = null;
  private audioWriter: RtpPcmuTrackWriter | null = null;
  private resourceUrl: string | null = null;
  private activeWhipEtag: string | null = null;
  private state: ReconnectState = "idle";
  private closed = false;
  private establishing = false;
  private connectedFired = false;
  private trickle: TrickleIceForwarder | null = null;
  private candidateSub: { unSubscribe: () => void } | null = null;
  private lastKeyFrameRequestMs = Number.NEGATIVE_INFINITY;
  private frameWatchdogHandle: NodeJS.Timeout | null = null;
  private frameWatchdogLastFrames = 0;
  private frameWatchdogLastAdvanceMs = 0;
  private mediaTelemetryInitialized = false;
  private lastEncodedFrameTimestampUs: number | null = null;
  private lastIdrTimestampUs: number | null = null;
  private idrRequestCount = 0;
  private idrCompletionCount = 0;
  private pendingIdrRequests = 0;
  private encodedAccessUnitCount = 0;
  private publisherRtpPacketCount = 0;
  private firstRtpSent = false;

  constructor(config: WebRtcPublisherConfig, deps: WebRtcPublisherDeps = {}) {
    this.config = config;
    this.trickleIce = config.trickleIce ?? false;
    this.audioEnabled = config.audioEnabled ?? false;
    this.timer = deps.timer ?? defaultTimer;
    this.onBeforeEstablish = deps.onBeforeEstablish;
    this.onConnected = deps.onConnected;
    this.onKeyFrameRequest = deps.onKeyFrameRequest;
    this.onSourceFailure = deps.onSourceFailure;
    this.onLifecycleEvent = deps.onLifecycleEvent;
    this.createPeerConnection =
      deps.createPeerConnection ??
      (iceServers =>
        new RTCPeerConnection({
          iceServers,
          // RFC 9725 §4.4.1 requires the WHIP client to use max-bundle. Besides
          // sharing one transport, this ensures only the offerer-tagged m-line
          // gathers/trickles ICE candidates (RFC 9725 §4.3.2).
          bundlePolicy: "max-bundle",
          codecs: this.audioEnabled
            ? { video: [useH264({ parameters: h264CodecParameters() })], audio: [usePCMU()] }
            : { video: [useH264({ parameters: h264CodecParameters() })] },
        }));
    const createWhip = deps.createWhipClient ?? (options => new WhipClient(options));
    this.whip = createWhip({
      // Pass the stream id to the ingest endpoint so a coordination server that
      // keys streams by id (like the bundled reference server, which reads
      // ?streamId=) uses the requested id rather than minting a random one.
      endpoint: withStreamId(config.whipEndpoint, config.streamId),
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
    try {
      const framesBefore = this.writer?.stats.framesWritten ?? 0;
      this.writer?.writeChunk(chunk);
      this.recordFirstRtpIfConnected(framesBefore);
    } catch (error) {
      const sourceFailure = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        `[WebRTC] stream ${this.config.streamId} emitted an H.264 stream outside its negotiated capability: ${sourceFailure.message}`
      );
      this.notifySourceFailed(sourceFailure);
    }
  }

  private recordFirstRtpIfConnected(framesBefore: number): void {
    if (this.firstRtpSent || this.pc?.connectionState !== "connected") {
      return;
    }
    if ((this.writer?.stats.framesWritten ?? 0) <= framesBefore) {
      return;
    }
    this.firstRtpSent = true;
    this.onLifecycleEvent?.("first_rtp_sent");
  }

  /**
   * Prime the current RTP writer with parameter sets captured while the source
   * was warm but no publisher track existed yet.
   */
  primeH264ParameterSets(sps: Buffer | null, pps: Buffer | null): void {
    this.writer?.primeParameterSets(sps, pps);
  }

  /** Feed 8 kHz mono PCM16LE audio; ignored when audio is not enabled. */
  writePcmAudioChunk(chunk: Buffer): void {
    this.audioWriter?.writePcm16Chunk(chunk);
  }

  /**
   * Report that the capture source failed. Unlike a WebRTC connection drop this
   * does not change the peer `connectionState`, so without this hook a dead
   * source would leave the viewer on a frozen frame with no recovery. Triggers
   * the reconnect loop, which tears down and re-establishes. The manager
   * recreates capture only when this source-failure path requires it.
   */
  notifySourceFailed(error?: Error): void {
    if (this.closed) {
      return;
    }
    const detail = error ? `: ${error.message}` : "";
    logger.warn(
      `[WebRTC] stream ${this.config.streamId} capture source failed${detail}; reconnecting`
    );
    this.onSourceFailure?.(error ?? new Error("Capture source stopped producing media."));
    this.controller.notifyConnectionLost();
  }

  /**
   * Forward a keyframe request to the capture source, throttled and guarded on
   * the peer connection identity so a PLI arriving for a superseded session (or
   * after close) is ignored.
   */
  private handleKeyFrameRequest(pc: RTCPeerConnection): void {
    if (this.closed || this.pc !== pc || !this.onKeyFrameRequest) {
      return;
    }
    const now = this.timer.now();
    if (now - this.lastKeyFrameRequestMs < KEYFRAME_REQUEST_MIN_INTERVAL_MS) {
      return;
    }
    this.lastKeyFrameRequestMs = now;
    logger.debug(`[WebRTC] stream ${this.config.streamId} received PLI; requesting keyframe`);
    try {
      const recoveryStarted = this.onKeyFrameRequest();
      // An accepted PLI can restart the iOS encoder. Do not let a watchdog
      // deadline that was already nearly expired tear down that recovery before
      // its replacement has a chance to emit the requested IDR.
      if (recoveryStarted) {
        this.noteKeyFrameRequest();
        this.resetFrameWatchdogDeadline(pc);
      }
    } catch (error) {
      logger.debug(`[WebRTC] keyframe request failed for ${this.config.streamId}: ${error}`);
    }
  }

  getState(): ReconnectState {
    return this.state;
  }

  getDescriptor(): WebRtcStreamDescriptor {
    const stats = this.writer?.stats;
    const audioStats = this.audioWriter?.stats;
    return {
      streamId: this.config.streamId,
      state: this.state,
      whipEndpoint: this.config.whipEndpoint,
      resourceUrl: this.resourceUrl,
      iceServers: this.config.iceServers ?? [],
      framesSent: stats?.framesWritten ?? 0,
      packetsSent: stats?.packetsWritten ?? 0,
      audioPacketsSent: audioStats?.packetsWritten ?? 0,
      audioSamplesSent: audioStats?.samplesWritten ?? 0,
      readiness: this.getReadiness(),
    };
  }

  /** Stop publishing and release the peer connection + ingest resource. */
  async stop(): Promise<void> {
    this.closed = true;
    this.controller.stop();
    await this.teardownActiveSession();
  }

  // eslint-disable-next-line complexity -- WHIP setup requires explicit cleanup at each failure boundary.
  private async establish(): Promise<void> {
    if (this.closed) {
      throw new Error("Publisher closed.");
    }
    this.establishing = true;
    this.connectedFired = false;
    // Discard any prior session (and stop the capture source) before building a
    // new one.
    await this.teardownActiveSession();

    await this.onBeforeEstablish?.();
    // stop() can race an asynchronous pre-establish hook (for example, source
    // setup). Do not allocate a peer connection or POST a WHIP offer after the
    // caller has explicitly stopped this publisher.
    if (this.closed) {
      throw new Error("Publisher closed during pre-establish.");
    }

    const pc = this.createPeerConnection(this.config.iceServers ?? []);
    this.pc = pc;

    try {
      // WHIP permits exactly one MediaStream; both media tracks share its id.
      const track = new MediaStreamTrack({ kind: "video", streamId: this.config.streamId });
      const transceiver = pc.addTransceiver(track, { direction: "sendonly" });
      // A downstream WHEP viewer that cannot decode sends a PLI; the coordination
      // server relays it here. Ask the capture source for a fresh IDR so the
      // viewer recovers promptly instead of waiting for the periodic keyframe.
      transceiver.sender.onPictureLossIndication.subscribe(() => this.handleKeyFrameRequest(pc));
      this.writer = new RtpH264TrackWriter({
        sink: track,
        ssrc: transceiver.sender.ssrc,
        mtu: this.config.mtu ?? DEFAULT_RTP_MTU,
        timer: this.timer,
        onSps: sps => {
          const spsCompatibility = evaluateH264SpsForSend(sps);
          if (!spsCompatibility.compatible) {
            throw new Error(spsCompatibility.reason);
          }
        },
        onAccessUnit: event => this.recordAccessUnit(event),
      });
      this.mediaTelemetryInitialized = true;
      this.firstRtpSent = false;
      if (this.audioEnabled) {
        const audioTrack = new MediaStreamTrack({ kind: "audio", streamId: this.config.streamId });
        const audioTransceiver = pc.addTransceiver(audioTrack, { direction: "sendonly" });
        this.audioWriter = new RtpPcmuTrackWriter({
          sink: audioTrack,
          ssrc: audioTransceiver.sender.ssrc,
        });
      }

      // Subscribe before createOffer()/setLocalDescription(): werift can emit a
      // host candidate while installing the local description. The subscription
      // buffers it until the SDP supplies the media/ICE context below.
      const activateTrickle = this.trickleIce ? this.subscribeTrickle(pc) : undefined;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.onLifecycleEvent?.("sdp_offer_created");

      // Trickle ICE publishes without waiting on gathering. Candidates emitted
      // before local SDP activation are retained by subscribeTrickle.
      if (activateTrickle) {
        activateTrickle();
      } else {
        await this.waitForIceGathering(pc);
      }

      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) {
        throw new Error("Failed to produce a local SDP offer.");
      }

      // werift implements rtcp-mux but does not serialize the WHIP-required
      // rtcp-mux-only attribute. It is an SDP signalling constraint; werift's
      // transport remains multiplexed after local description is installed.
      const session = await this.whip.publish(addWhipRtcpMuxOnly(localSdp));
      this.onLifecycleEvent?.("whip_answer_received");

      // stop() may have run while we were awaiting ICE/WHIP. The WHIP session now
      // exists on the server but teardown already happened (before resourceUrl was
      // set), so tear this one down explicitly instead of accepting it — otherwise
      // it leaks after the stream was reported stopped.
      if (this.closed || this.pc !== pc) {
        if (session.resourceUrl) {
          await this.whip.delete(session.resourceUrl).catch(() => {});
        }
        await pc.close().catch(() => {});
        throw new Error("Publisher closed during establish.");
      }

      this.resourceUrl = session.resourceUrl;
      this.activeWhipEtag = session.etag;
      if (this.trickleIce && !session.etag) {
        throw new Error("WHIP server did not return the ETag required for Trickle ICE.");
      }
      // Flush candidates gathered during the WHIP round-trip and stream the rest.
      this.trickle?.setResource(session.resourceUrl);
      await pc.setRemoteDescription({ type: "answer", sdp: session.answerSdp });
      // WHIP forbids a misleading partially successful ingest session: reject
      // an answer that did not accept each requested media section.
      // RFC 9725 §4.4.3: https://www.rfc-editor.org/rfc/rfc9725.html#section-4.4.3
      assertWhipAnswerAcceptsMedia(session.answerSdp, "video", "h264");
      if (this.audioEnabled) {
        assertWhipAnswerAcceptsMedia(session.answerSdp, "audio", "pcmu");
      }

      this.establishing = false;
      this.watchConnectionState(pc);
      // The connection may already have completed while we were awaiting the WHIP
      // round-trip; fire the connected hook now if so (the event won't re-fire).
      if (pc.connectionState === "connected") {
        this.fireConnected(pc);
      }
      logger.info(
        `[WebRTC] stream ${this.config.streamId} published to ${this.config.whipEndpoint}` +
          (session.resourceUrl ? ` (resource ${session.resourceUrl})` : "")
      );
    } catch (error) {
      // Any failure after the peer connection was created (offer, ICE, WHIP
      // publish) leaves an open pc. On a terminal "failed" state there is no next
      // reconnect attempt to tear it down, so close it here. Guard on identity so
      // we never close a pc a concurrent teardown/establish already replaced.
      if (this.pc === pc) {
        const resourceUrl = this.resourceUrl;
        this.resourceUrl = null;
        this.activeWhipEtag = null;
        this.pc = null;
        this.writer = null;
        this.audioWriter = null;
        this.trickle?.stop();
        this.trickle = null;
        this.candidateSub?.unSubscribe();
        this.candidateSub = null;
        if (resourceUrl) {
          await this.whip.delete(resourceUrl).catch(() => {});
        }
        await pc.close().catch(() => {});
      }
      throw error;
    }
  }

  private watchConnectionState(pc: RTCPeerConnection): void {
    pc.connectionStateChange.subscribe(state => {
      if (this.closed || this.pc !== pc) {
        return;
      }
      if (state === "connected") {
        this.fireConnected(pc);
        return;
      }
      if (this.establishing) {
        return;
      }
      if (state === "failed" || state === "disconnected") {
        logger.warn(`[WebRTC] stream ${this.config.streamId} connection ${state}; reconnecting`);
        this.controller.notifyConnectionLost();
      }
    });
    // An ICE/DTLS failure can arrive before the subscription above is installed.
    // werift does not replay prior state changes, so inspect the current state too.
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      this.controller.notifyConnectionLost();
    }
  }

  /** Start capture (once per session) now that media can actually flow. */
  private fireConnected(pc: RTCPeerConnection): void {
    if (this.connectedFired || this.pc !== pc || this.closed) {
      return;
    }
    this.connectedFired = true;
    this.onLifecycleEvent?.("ice_connected");
    void Promise.resolve()
      .then(() => this.onConnected?.())
      .then(() => {
        if (!this.closed && this.pc === pc) {
          // Source startup can include device discovery, permission checks, and
          // encoder launch. Only measure frame stalls once that work succeeds.
          this.startFrameWatchdog(pc);
        }
      })
      .catch(error => {
        // Capture failed to start (e.g. adb/screenrecord spawn failed) even though
        // the peer connected. Without this the stream would report connected with
        // no media and never recover — route it through the reconnect path.
        logger.warn(`[WebRTC] capture start failed for ${this.config.streamId}: ${error}; reconnecting`);
        this.notifySourceFailed();
      });
  }

  /**
   * Watch for a connected-but-stalled stream: the source is alive (no
   * connection-state change) yet the frame counter stops advancing. Baselined at
   * connect, so a source that never produces a first frame within the timeout is
   * also caught after capture startup completes. On a stall, route through
   * reconnect and manager-directed capture recovery.
   */
  private startFrameWatchdog(pc: RTCPeerConnection): void {
    const timeout = this.config.frameStallTimeoutMs;
    if (!timeout || timeout <= 0) {
      return;
    }
    this.stopFrameWatchdog();
    this.frameWatchdogLastFrames = this.writer?.stats.framesWritten ?? 0;
    this.frameWatchdogLastAdvanceMs = this.timer.now();
    const intervalMs = Math.max(500, Math.min(timeout, 2000));
    this.frameWatchdogHandle = this.timer.setInterval(() => this.checkFrameProgress(pc, timeout), intervalMs);
  }

  /** Give an accepted keyframe recovery one bounded frame-stall interval to produce its IDR. */
  private resetFrameWatchdogDeadline(pc: RTCPeerConnection): void {
    if (
      !this.frameWatchdogHandle ||
      this.closed ||
      this.pc !== pc ||
      pc.connectionState !== "connected"
    ) {
      return;
    }
    this.frameWatchdogLastFrames = this.writer?.stats.framesWritten ?? 0;
    this.frameWatchdogLastAdvanceMs = this.timer.now();
  }

  private checkFrameProgress(pc: RTCPeerConnection, timeoutMs: number): void {
    if (this.closed || this.establishing || this.pc !== pc || pc.connectionState !== "connected") {
      return;
    }
    const frames = this.writer?.stats.framesWritten ?? 0;
    if (frames > this.frameWatchdogLastFrames) {
      this.frameWatchdogLastFrames = frames;
      this.frameWatchdogLastAdvanceMs = this.timer.now();
      return;
    }
    if (this.timer.now() - this.frameWatchdogLastAdvanceMs >= timeoutMs) {
      logger.warn(
        `[WebRTC] stream ${this.config.streamId} produced no frames for ${timeoutMs}ms while connected ` +
          `(framesSent=${frames}); treating capture as stalled and reconnecting`
      );
      this.stopFrameWatchdog();
      this.notifySourceFailed();
    }
  }

  private stopFrameWatchdog(): void {
    if (this.frameWatchdogHandle) {
      this.timer.clearInterval(this.frameWatchdogHandle);
      this.frameWatchdogHandle = null;
    }
  }

  private noteKeyFrameRequest(): void {
    this.mediaTelemetryInitialized = true;
    this.idrRequestCount++;
    this.pendingIdrRequests++;
  }

  private getReadiness(): WebRtcStreamReadiness {
    if (!this.mediaTelemetryInitialized) {
      return {
        lastEncodedFrameTimestampUs: null,
        lastIdrTimestampUs: null,
        idrRequestCount: null,
        idrCompletionCount: null,
        encodedAccessUnitCount: null,
        publisherRtpPacketCount: null,
        captureSourceState: "not_initialized",
        lastSourceError: null,
      };
    }
    return {
      lastEncodedFrameTimestampUs: this.lastEncodedFrameTimestampUs,
      lastIdrTimestampUs: this.lastIdrTimestampUs,
      idrRequestCount: this.idrRequestCount,
      idrCompletionCount: this.idrCompletionCount,
      encodedAccessUnitCount: this.encodedAccessUnitCount,
      publisherRtpPacketCount: this.publisherRtpPacketCount,
      captureSourceState: "not_initialized",
      lastSourceError: null,
    };
  }

  private recordAccessUnit(event: {
    timestampMs: number;
    isIdr: boolean;
    rtpPacketCount: number;
  }): void {
    this.mediaTelemetryInitialized = true;
    this.lastEncodedFrameTimestampUs = event.timestampMs * 1000;
    this.encodedAccessUnitCount++;
    this.publisherRtpPacketCount += event.rtpPacketCount;
    if (!event.isIdr) {
      return;
    }
    this.lastIdrTimestampUs = event.timestampMs * 1000;
    if (this.pendingIdrRequests > 0) {
      this.pendingIdrRequests--;
      this.idrCompletionCount++;
    }
  }

  /**
   * Begin trickling local ICE candidates for this session. Candidates are
   * buffered by the forwarder until the WHIP resource URL is known (set right
   * after publish), then PATCHed as `application/trickle-ice-sdpfrag`.
   */
  private subscribeTrickle(pc: RTCPeerConnection): () => void {
    const pendingCandidates: Array<{
      candidate: string;
      sdpMid?: string;
      sdpMLineIndex?: number;
    } | null | undefined> = [];
    let forwarder: TrickleIceForwarder | null = null;
    const addCandidate = (candidate: {
      candidate: string;
      sdpMid?: string;
      sdpMLineIndex?: number;
    } | null | undefined): void => {
      if (!forwarder) {
        pendingCandidates.push(candidate);
        return;
      }
      if (candidate) {
        forwarder.addCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        });
      } else {
        forwarder.completeGathering();
      }
    };
    this.candidateSub = pc.onIceCandidate.subscribe(candidate => {
      if (this.pc === pc) {
        addCandidate(candidate);
      }
    });

    return () => {
      if (this.pc !== pc || forwarder) {
        return;
      }
      const contexts = parseTrickleIceMediaContexts(pc.localDescription?.sdp ?? "");
      forwarder = new TrickleIceForwarder((resourceUrl, fragment) => {
        const etag = this.activeWhipEtag;
        if (!etag) {
          return;
        }
        void this.whip.patchCandidate(resourceUrl, etag, fragment).catch(error => {
          logger.debug(`[WebRTC] trickle candidate PATCH failed: ${error}`);
        });
      }, contexts);
      this.trickle = forwarder;
      for (const candidate of pendingCandidates) {
        addCandidate(candidate);
      }
      pendingCandidates.length = 0;
    };
  }

  private async waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") {
      this.onLifecycleEvent?.("ice_gathering_complete");
      return;
    }
    this.onLifecycleEvent?.("ice_gathering_started");
    try {
      await pc.iceGatheringStateChange.watch(
        state => state === "complete",
        ICE_GATHERING_TIMEOUT_MS
      );
      this.onLifecycleEvent?.("ice_gathering_complete");
    } catch {
      // Timed out — proceed with whatever candidates gathered so far. Non-trickle
      // WHIP servers still often connect via the host/srflx candidates present.
      logger.warn(`[WebRTC] ICE gathering did not complete within ${ICE_GATHERING_TIMEOUT_MS}ms; publishing partial offer`);
      this.onLifecycleEvent?.("ice_gathering_timeout");
    }
  }

  private async teardownActiveSession(): Promise<void> {
    this.stopFrameWatchdog();
    const pc = this.pc;
    const resourceUrl = this.resourceUrl;
    this.pc = null;
    this.writer = null;
    this.audioWriter = null;
    this.resourceUrl = null;
    this.activeWhipEtag = null;

    // Stop forwarding candidates and detach the listener before the pc closes.
    this.trickle?.stop();
    this.trickle = null;
    this.candidateSub?.unSubscribe();
    this.candidateSub = null;

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

function assertWhipAnswerAcceptsMedia(
  answerSdp: string,
  kind: "audio" | "video",
  codec: "h264" | "pcmu"
): void {
  const section = findSdpMediaSection(answerSdp, kind);
  if (!section) {
    throw new Error(`WHIP answer did not include a ${kind} m-line.`);
  }

  const { mediaLine, attributeLines, sessionDirection } = section;
  const mediaParts = mediaLine.split(/\s+/);
  const port = Number(mediaParts[1]);
  const formats = new Set(mediaParts.slice(3));
  if (!Number.isFinite(port) || port === 0) {
    throw new Error(`WHIP answer rejected the requested ${kind} m-line.`);
  }

  const direction =
    attributeLines
      .map(line => line.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/)?.[1])
      .find((value): value is "sendrecv" | "sendonly" | "recvonly" | "inactive" => value !== undefined) ??
    sessionDirection ?? "sendrecv";
  // WHIP is unidirectional ingest: an accepting endpoint MUST answer recvonly
  // (RFC 9725 §4.2). Accepting sendrecv would make AutoMobile interoperate with
  // a non-conforming endpoint and hide an invalid session contract.
  if (direction !== "recvonly") {
    throw new Error(`WHIP answer did not accept receiving ${kind} (direction=${direction}).`);
  }

  const staticPayloadType = codec === "pcmu" ? "0" : undefined;
  const accepted =
    (staticPayloadType !== undefined && formats.has(staticPayloadType)) ||
    attributeLines.some(line => isAcceptedCodecRtpMap(line, formats, codec, attributeLines));
  if (!accepted) {
    throw new Error(`WHIP answer did not accept ${codec.toUpperCase()} ${kind}.`);
  }
}

function findSdpMediaSection(sdp: string, kind: "audio" | "video"): {
  mediaLine: string;
  attributeLines: string[];
  sessionDirection?: "sendrecv" | "sendonly" | "recvonly" | "inactive";
} | null {
  const lines = sdp.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const firstMedia = lines.findIndex(line => line.startsWith("m="));
  const sessionDirection = lines
    .slice(0, firstMedia < 0 ? lines.length : firstMedia)
    .map(line => line.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/)?.[1])
    .find((value): value is "sendrecv" | "sendonly" | "recvonly" | "inactive" => value !== undefined);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith(`m=${kind} `)) {
      continue;
    }
    const attributeLines: string[] = [];
    for (let sectionIndex = index + 1; sectionIndex < lines.length; sectionIndex++) {
      if (lines[sectionIndex].startsWith("m=")) {
        break;
      }
      attributeLines.push(lines[sectionIndex]);
    }
    return { mediaLine: lines[index], attributeLines, sessionDirection };
  }
  return null;
}

function isAcceptedCodecRtpMap(
  line: string,
  formats: Set<string>,
  codec: string,
  attributeLines: string[]
): boolean {
  const match = line.match(/^a=rtpmap:(\S+)\s+([^/\s]+)\/(\d+)/i);
  if (!match || !formats.has(match[1]) || match[2].toLowerCase() !== codec) {
    return false;
  }
  if (codec !== "h264") {
    return true;
  }
  // AutoMobile packetizes H.264 at the RFC 6184 fixed 90 kHz clock rate and
  // uses FU-A, which requires packetization-mode=1. The local werift codec is
  // constrained-baseline 42e0xx; level may differ when asymmetry is negotiated.
  return match[3] === "90000" && attributeLines.some(fmtp => {
    if (!fmtp.startsWith(`a=fmtp:${match[1]} `)) {
      return false;
    }
    const parameters = fmtp.slice(fmtp.indexOf(" ") + 1);
    const packetizationMode = /(?:^|;)\s*packetization-mode\s*=\s*1(?:;|$)/i.test(parameters);
    const profileLevelId = /(?:^|;)\s*profile-level-id\s*=\s*([0-9a-f]{6})(?:;|$)/i.exec(parameters)?.[1];
    return packetizationMode && profileLevelId !== undefined && acceptsLocalH264Send(parameters, profileLevelId);
  });
}

function h264CodecParameters(): string {
  return `profile-level-id=${WEBRTC_H264_PROFILE_LEVEL_ID};packetization-mode=1;level-asymmetry-allowed=1`;
}

function acceptsLocalH264Send(parameters: string, profileLevelId: string): boolean {
  if (!isCompatibleConstrainedBaselineProfile(profileLevelId)) {
    return false;
  }
  const answerLevelIdc = Number.parseInt(profileLevelId.slice(4, 6), 16);
  if (answerLevelIdc >= WEBRTC_H264_LEVEL_IDC) {
    return true;
  }
  // With level asymmetry, the answer's profile-level-id describes its sending
  // level; max-recv-level is its separately advertised receive ceiling (RFC
  // 6184 §8.2.2). Do not send a Level 4.2 stream unless that ceiling permits it.
  const asymmetric = /(?:^|;)\s*level-asymmetry-allowed\s*=\s*1(?:;|$)/i.test(parameters);
  const maxReceiveLevel = /(?:^|;)\s*max-recv-level\s*=\s*([0-9a-f]{4})(?:;|$)/i.exec(parameters)?.[1];
  // RFC 6184 §8.2.2 encodes max-recv-level as the two hexadecimal bytes after
  // profile_idc in an SPS: profile-iop followed by level_idc (for example,
  // e02a for constrained-baseline Level 4.2). It is not a decimal level number.
  const maxReceiveLevelIdc = maxReceiveLevel
    ? Number.parseInt(maxReceiveLevel.slice(2), 16)
    : Number.NaN;
  return asymmetric && maxReceiveLevelIdc >= WEBRTC_H264_LEVEL_IDC;
}

function addWhipRtcpMuxOnly(sdp: string): string {
  return sdp.replace(/a=rtcp-mux\r?\n/g, match => `${match}a=rtcp-mux-only\r\n`);
}

/**
 * Append a `streamId` query parameter to a WHIP endpoint. Servers that key
 * streams by id (the bundled reference server) pick it up; standard WHIP servers
 * that address streams by path ignore the extra query parameter.
 */
function withStreamId(endpoint: string, streamId: string): string {
  try {
    const url = new URL(endpoint);
    if (!url.searchParams.has("streamId")) {
      url.searchParams.set("streamId", streamId);
    }
    return url.toString();
  } catch (error) {
    logger.debug(`[WebRTC] could not append streamId to WHIP endpoint ${endpoint}: ${error}`);
    return endpoint;
  }
}
