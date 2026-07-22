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
import { parseTrickleIceMediaContexts, TrickleIceForwarder } from "./trickleIce";
import { WhipClient, type WhipClientOptions } from "./WhipClient";

/**
 * How long to wait for ICE gathering before publishing the offer.
 *
 * Protocol background: [ICE (RFC 8445)](https://www.rfc-editor.org/rfc/rfc8445.html).
 * AutoMobile's bounded non-trickle wait is an implementation choice; enable
 * `trickleIce` for the WHIP extension described in `trickleIce.ts`.
 */
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
  /**
   * Use trickle ICE: publish the offer immediately and PATCH local candidates
   * as they gather, instead of blocking on ICE gathering. Requires an ingest
   * server that supports the WHIP trickle extension. Defaults to false.
   */
  trickleIce?: boolean;
  /** Add a sendonly PCMU audio track alongside video. Defaults to false. */
  audioEnabled?: boolean;
}

export interface WebRtcPublisherDeps {
  /** Factory for peer connections (injectable for tests). */
  createPeerConnection?: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  /** Factory for the WHIP client (injectable for tests). */
  createWhipClient?: (options: WhipClientOptions) => WhipClient;
  timer?: Timer;
  /**
   * Called at the start of each (re)establish, before the offer is built. The
   * manager uses this to STOP any existing capture source so the next session
   * starts clean.
   */
  onBeforeEstablish?: () => Promise<void> | void;
  /**
   * Called once the peer connection reaches `connected`. The manager uses this
   * to START the capture source, so the first SPS/PPS + IDR is emitted over a
   * live connection instead of being dropped before DTLS is ready.
   */
  onConnected?: () => Promise<void> | void;
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
  audioPacketsSent: number;
  audioSamplesSent: number;
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

  constructor(config: WebRtcPublisherConfig, deps: WebRtcPublisherDeps = {}) {
    this.config = config;
    this.trickleIce = config.trickleIce ?? false;
    this.audioEnabled = config.audioEnabled ?? false;
    this.timer = deps.timer ?? defaultTimer;
    this.onBeforeEstablish = deps.onBeforeEstablish;
    this.onConnected = deps.onConnected;
    this.createPeerConnection =
      deps.createPeerConnection ??
      (iceServers =>
        new RTCPeerConnection({
          iceServers,
          codecs: this.audioEnabled
            ? { video: [useH264()], audio: [usePCMU()] }
            : { video: [useH264()] },
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
    this.writer?.writeChunk(chunk);
  }

  /** Feed 8 kHz mono PCM16LE audio; ignored when audio is not enabled. */
  writePcmAudioChunk(chunk: Buffer): void {
    this.audioWriter?.writePcm16Chunk(chunk);
  }

  /**
   * Report that the capture source failed. Unlike a WebRTC connection drop this
   * does not change the peer `connectionState`, so without this hook a dead
   * source would leave the viewer on a frozen frame with no recovery. Triggers
   * the reconnect loop, which tears down and re-establishes (restarting capture).
   */
  notifySourceFailed(): void {
    if (this.closed) {
      return;
    }
    logger.warn(`[WebRTC] stream ${this.config.streamId} capture source failed; reconnecting`);
    this.controller.notifyConnectionLost();
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
    this.connectedFired = false;
    // Discard any prior session (and stop the capture source) before building a
    // new one.
    await this.teardownActiveSession();

    await this.onBeforeEstablish?.();

    const pc = this.createPeerConnection(this.config.iceServers ?? []);
    this.pc = pc;

    try {
      // WHIP permits exactly one MediaStream; both media tracks share its id.
      const track = new MediaStreamTrack({ kind: "video", streamId: this.config.streamId });
      const transceiver = pc.addTransceiver(track, { direction: "sendonly" });
      this.writer = new RtpH264TrackWriter({
        sink: track,
        ssrc: transceiver.sender.ssrc,
        mtu: this.config.mtu ?? DEFAULT_RTP_MTU,
        timer: this.timer,
      });
      if (this.audioEnabled) {
        const audioTrack = new MediaStreamTrack({ kind: "audio", streamId: this.config.streamId });
        const audioTransceiver = pc.addTransceiver(audioTrack, { direction: "sendonly" });
        this.audioWriter = new RtpPcmuTrackWriter({
          sink: audioTrack,
          ssrc: audioTransceiver.sender.ssrc,
        });
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Trickle ICE: start forwarding candidates (buffered until the resource URL
      // is known) and publish the offer immediately instead of blocking on ICE
      // gathering. Non-trickle: gather (bounded) before publishing.
      if (this.trickleIce) {
        this.startTrickle(pc);
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
    void Promise.resolve(this.onConnected?.()).catch(error => {
      // Capture failed to start (e.g. adb/screenrecord spawn failed) even though
      // the peer connected. Without this the stream would report connected with
      // no media and never recover — route it through the reconnect path.
      logger.warn(`[WebRTC] capture start failed for ${this.config.streamId}: ${error}; reconnecting`);
      this.notifySourceFailed();
    });
  }

  /**
   * Begin trickling local ICE candidates for this session. Candidates are
   * buffered by the forwarder until the WHIP resource URL is known (set right
   * after publish), then PATCHed as `application/trickle-ice-sdpfrag`.
   */
  private startTrickle(pc: RTCPeerConnection): void {
    const contexts = parseTrickleIceMediaContexts(pc.localDescription?.sdp ?? "");
    const forwarder = new TrickleIceForwarder((resourceUrl, fragment) => {
      const etag = this.activeWhipEtag;
      if (!etag) {
        return;
      }
      void this.whip.patchCandidate(resourceUrl, etag, fragment).catch(error => {
        logger.debug(`[WebRTC] trickle candidate PATCH failed: ${error}`);
      });
    }, contexts);
    this.trickle = forwarder;
    this.candidateSub = pc.onIceCandidate.subscribe(candidate => {
      if (this.pc !== pc) {
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
  if (direction !== "recvonly" && direction !== "sendrecv") {
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
  const match = line.match(/^a=rtpmap:(\S+)\s+([^/\s]+)/i);
  if (!match || !formats.has(match[1]) || match[2].toLowerCase() !== codec) {
    return false;
  }
  return codec !== "h264" || attributeLines.some(fmtp =>
    fmtp.startsWith(`a=fmtp:${match[1]} `) && /(?:^|;)\s*packetization-mode\s*=\s*1(?:;|$)/i.test(fmtp.slice(fmtp.indexOf(" ") + 1))
  );
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
