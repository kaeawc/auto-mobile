import type { Socket } from "node:net";
import type { BootedDevice } from "../../models";
import type { DeviceCaptureRegistry } from "../../features/webrtc/deviceCaptureRegistry";
import type { H264CaptureSource } from "../../features/webrtc/H264CaptureSource";
import {
  H264AccessUnitAssembler,
  H264AnnexBParser,
  MAX_ANNEX_B_BUFFER_BYTES,
  nalUnitType,
  NAL_TYPE_IDR,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
} from "../../features/webrtc/h264";
import { SIMULATOR_FPS_DEFAULT } from "../../features/screen-stream/IosScreenCaptureHelper";
import { WEBRTC_ANDROID_FPS_DEFAULT } from "../../features/webrtc/webrtcStreamingConfig";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import {
  encodeDroppedFrames,
  encodeHeartbeat,
  encodePacket,
  encodePtsAndFlags,
} from "../videoStreamFraming";
import type { CaptureHints, CaptureSourceFactory, DeviceCapture } from "./captureTypes";

/** Server lifecycle operations needed by the media pipeline. */
export interface VideoStreamCapturePipelineHost {
  getCapture(deviceId: string): DeviceCapture | undefined;
  detach(socket: Socket): void;
  stopCapture(deviceId: string, stale?: boolean): Promise<void>;
}

export interface VideoStreamCapturePipelineDependencies {
  createCaptureSource: CaptureSourceFactory;
  nowUs: () => bigint;
  outboundStallTimeoutMs?: number;
}

const ANNEX_B_START_CODE = Buffer.from([0, 0, 0, 1]);
export const OUTBOUND_STALL_TIMEOUT_MS = 30_000;

// A key-frame request can be rejected when the capture source is rate-limiting them (Android and
// raw iOS gate requests for ~3s, encoded iOS for ~500ms). When one is throttled we retry on the
// injected timer instead of leaving the subscriber frozen until the encoder's natural GOP. The
// interval × attempts span the widest (~3s) throttle window with headroom.
const KEY_FRAME_RETRY_INTERVAL_MS = 500;
const KEY_FRAME_RETRY_MAX_ATTEMPTS = 8;

/**
 * Cadence for the relay-originated heartbeat (issue #7549), also advertised to the client in the
 * subscribe ack (`heartbeatMs`) so it can size its own stall-reconnect window.
 */
export const HEARTBEAT_INTERVAL_MS = 1_000;
// Give screenrecord and iOS's encoder time to answer a key-frame request before allowing the
// desktop's 10s stall watchdog to reconnect. A silent-but-attached process cannot extend this.
const SOURCE_PROBE_AFTER_MS = 6_000;
const SOURCE_EVIDENCE_MAX_AGE_MS = 9_000;

function defaultCaptureFps(device: BootedDevice): number {
  return device.platform === "android" ? WEBRTC_ANDROID_FPS_DEFAULT : SIMULATOR_FPS_DEFAULT;
}

/** H.264 delivery, replay, backpressure recovery and capture liveness for the socket relay. */
export class VideoStreamCapturePipeline {
  constructor(
    private readonly host: VideoStreamCapturePipelineHost,
    private readonly deps: VideoStreamCapturePipelineDependencies,
    private readonly captureRegistry: DeviceCaptureRegistry,
    private readonly timer: Timer,
    private readonly outboundStalls: Map<Socket, { timeout: NodeJS.Timeout; onDrain: () => void }>,
  ) {}

  async createSource(
    capture: DeviceCapture,
    hints: CaptureHints,
    generation: number,
  ): Promise<H264CaptureSource> {
    const { device } = capture;
    const deviceId = device.deviceId;
    const attestSource = (): void => {
      if (this.host.getCapture(deviceId) !== capture || capture.generation !== generation) {
        return;
      }
      capture.lastSourceDataMs = this.timer.now();
      capture.firstEvidenceMs ??= capture.lastSourceDataMs;
      capture.sourceFrameSequence++;
      capture.lastIdleMs = null;
      capture.encodedSinceSourceFrame = false;
      if (!capture.heartbeatTimer) {
        this.startHeartbeat(deviceId, capture);
      }
    };
    const consumeData = (chunk: Buffer, fresh: boolean): void => {
      const current = this.host.getCapture(deviceId);
      if (current !== capture || capture.generation !== generation || chunk.length === 0) {
        return;
      }
      if (fresh) {
        current.lastEncodedDataMs = this.timer.now();
        current.firstEvidenceMs ??= current.lastEncodedDataMs;
        current.encodedSinceSourceFrame = true;
        if (!current.heartbeatTimer) {
          this.startHeartbeat(deviceId, current);
        }
      }
      this.broadcast(deviceId, chunk);
    };
    return this.captureRegistry.acquire({
      device,
      create: (options) => this.deps.createCaptureSource({ ...options, onError: options.onError! }),
      hasConsumers: capture.pendingSubscribers.size > 0 || capture.subscribers.size > 0,
      flexibleHints: hints.fps === undefined ? ["fps"] : [],
      options: {
        device,
        onData: (chunk) => consumeData(chunk, true),
        onReplayData: (chunk) => consumeData(chunk, false),
        onSourceFrame: attestSource,
        onSourceIdle: () => {
          if (
            this.host.getCapture(deviceId) !== capture ||
            capture.generation !== generation ||
            !capture.encodedSinceSourceFrame
          ) {
            return;
          }
          capture.lastIdleMs = this.timer.now();
        },
        onEncodedAccessUnit: () => {
          if (this.host.getCapture(deviceId) !== capture || capture.generation !== generation) {
            return;
          }
          for (const nal of capture.parser.flush()) {
            this.broadcastNal(deviceId, capture, nal);
          }
          this.cacheCompletedAccessUnits(capture, capture.keyFrameAssembler.flush());
          capture.keyFrameAuBytes = 0;
          capture.lastEncodedBoundarySequence = capture.sourceFrameSequence;
        },
        onIdleAttestationSupport: (supported) => {
          if (
            this.host.getCapture(deviceId) === capture &&
            capture.generation === generation &&
            device.platform === "ios"
          ) {
            capture.legacySimulatorHelper = !supported;
          }
        },
        // Record the source's attested rotation so the next config packet re-attests it to
        // subscribers, including a late joiner via replayParameterSets (issue #4786).
        onRotation: (rotation) => {
          const current = this.host.getCapture(deviceId);
          if (current === capture && capture.generation === generation) {
            current.rotation = rotation;
          }
        },
        onDroppedFrames: (droppedFrames) => {
          const current = this.host.getCapture(deviceId);
          if (
            current !== capture ||
            capture.generation !== generation ||
            !Number.isSafeInteger(droppedFrames) ||
            droppedFrames < 0 ||
            !this.sourceEvidenceIsRecent(capture, this.timer.now())
          ) {
            return;
          }
          const packet = encodeDroppedFrames(droppedFrames);
          for (const subscriber of capture.subscribers) {
            this.writePacketToSubscriber(deviceId, capture, subscriber, {
              packet,
              isConfig: false,
              isKeyFrame: false,
            });
          }
        },
        onError: (error) => {
          if (this.host.getCapture(deviceId) === capture && capture.generation === generation) {
            logger.warn(`[VideoStream] capture failed for ${deviceId}: ${error}`);
            void this.host.stopCapture(deviceId);
          }
        },
        bitrateBps: hints.bitrateKbps ? hints.bitrateKbps * 1000 : undefined,
        size: hints.size,
        quality: hints.quality,
        // Use the observation rate for this platform when the client sent no hint.
        // A client hint wins so farm viewers can lower the rate across streams.
        fps: hints.fps ?? defaultCaptureFps(device),
      },
    });
  }

  resetForNewEncoder(capture: DeviceCapture): void {
    this.clearHeartbeatTimer(capture);
    capture.parser = new H264AnnexBParser();
    capture.keyFrameAssembler = new H264AccessUnitAssembler();
    capture.keyFrameAuBytes = 0;
    capture.sps = null;
    capture.pps = null;
    capture.latestKeyFrameAu = null;
    capture.latestInterFrameAus = [];
    capture.cachedGopBytes = 0;
    capture.rotation = null;
    capture.firstEvidenceMs = null;
    capture.lastSourceDataMs = null;
    capture.lastEncodedDataMs = null;
    capture.lastIdleMs = null;
    capture.lastLivenessProbeMs = null;
    capture.encodedSinceSourceFrame = false;
    capture.legacySimulatorHelper = false;
    capture.sourceFrameSequence = 0;
    capture.lastEncodedBoundarySequence = null;
    for (const subscriber of capture.subscribers) {
      capture.waitingForKeyFrame.add(subscriber);
    }
  }

  primeSubscriber(capture: DeviceCapture, socket: Socket): void {
    this.replayParameterSets(capture, socket);
    this.replayCurrentIosKeyFrame(capture.device, capture, socket);
  }

  private broadcast(deviceId: string, chunk: Buffer): void {
    const capture = this.host.getCapture(deviceId);
    if (!capture || chunk.length === 0) {
      return;
    }

    // Source chunks are arbitrary byte boundaries. Split incrementally so a start code or NAL
    // spanning two reads cannot be mistaken for a complete frame.
    for (const nal of capture.parser.push(chunk)) {
      this.broadcastNal(deviceId, capture, nal);
    }
  }

  private broadcastNal(deviceId: string, capture: DeviceCapture, nal: Buffer): void {
    const type = nalUnitType(nal);
    this.cacheCompleteKeyFrame(capture, nal, type);
    const isConfig = type === NAL_TYPE_SPS || type === NAL_TYPE_PPS;
    if (type === NAL_TYPE_SPS) {
      capture.sps = Buffer.from(nal);
    }
    if (type === NAL_TYPE_PPS) {
      capture.pps = Buffer.from(nal);
    }

    const isKeyFrame = type === NAL_TYPE_IDR;
    // Attest the current rotation on config packets so a client can re-prove orientation from the
    // live stream alone after a rotation (issue #4786); non-config packets carry no rotation.
    const rotation = isConfig ? capture.rotation : null;
    const packet = encodePacket(
      encodePtsAndFlags(this.deps.nowUs(), { isConfig, isKeyFrame, rotation }),
      Buffer.concat([ANNEX_B_START_CODE, nal]),
    );

    for (const subscriber of capture.subscribers) {
      this.writePacketToSubscriber(deviceId, capture, subscriber, { packet, isConfig, isKeyFrame });
    }
  }

  private cacheCompleteKeyFrame(capture: DeviceCapture, nal: Buffer, type: number): void {
    const completed = capture.keyFrameAssembler.push(nal);
    capture.keyFrameAuBytes += nal.length;
    this.cacheCompletedAccessUnits(capture, completed);
    if (type === NAL_TYPE_SPS || type === NAL_TYPE_PPS) {
      // An old IDR may have completed exactly as a new parameter set arrived.
      capture.latestKeyFrameAu = null;
      capture.latestInterFrameAus = [];
      capture.cachedGopBytes = 0;
    }
    if (capture.keyFrameAuBytes > MAX_ANNEX_B_BUFFER_BYTES) {
      capture.keyFrameAssembler = new H264AccessUnitAssembler();
      capture.keyFrameAuBytes = 0;
    }
  }

  private cacheCompletedAccessUnits(capture: DeviceCapture, completed: Buffer[][]): void {
    for (const au of completed) {
      const bytes = au.reduce((sum, item) => sum + item.length, 0);
      capture.keyFrameAuBytes -= bytes;
      if (bytes > MAX_ANNEX_B_BUFFER_BYTES) {
        capture.latestKeyFrameAu = null;
        capture.latestInterFrameAus = [];
        capture.cachedGopBytes = 0;
        continue;
      }
      const encoded = Buffer.concat(
        au
          .filter(
            (item) => nalUnitType(item) !== NAL_TYPE_SPS && nalUnitType(item) !== NAL_TYPE_PPS,
          )
          .flatMap((item) => [ANNEX_B_START_CODE, item]),
      );
      if (au.some((item) => nalUnitType(item) === NAL_TYPE_IDR)) {
        capture.latestKeyFrameAu = encoded;
        capture.latestInterFrameAus = [];
        capture.cachedGopBytes = encoded.length;
      } else if (capture.latestKeyFrameAu) {
        if (capture.cachedGopBytes + encoded.length > MAX_ANNEX_B_BUFFER_BYTES) {
          capture.latestKeyFrameAu = null;
          capture.latestInterFrameAus = [];
          capture.cachedGopBytes = 0;
        } else {
          capture.latestInterFrameAus.push(encoded);
          capture.cachedGopBytes += encoded.length;
        }
      }
    }
  }

  private replayKeyFrame(capture: DeviceCapture, socket: Socket, deviceId: string): void {
    if (!capture.sps || !capture.pps || !capture.latestKeyFrameAu) {
      return;
    }
    this.writePacketToSubscriber(deviceId, capture, socket, {
      packet: encodePacket(
        encodePtsAndFlags(this.deps.nowUs(), { isKeyFrame: true }),
        capture.latestKeyFrameAu,
      ),
      isConfig: false,
      isKeyFrame: true,
    });
    for (const au of capture.latestInterFrameAus) {
      this.writePacketToSubscriber(deviceId, capture, socket, {
        packet: encodePacket(encodePtsAndFlags(this.deps.nowUs(), {}), au),
        isConfig: false,
        isKeyFrame: false,
      });
    }
  }

  private replayCurrentIosKeyFrame(
    device: BootedDevice,
    capture: DeviceCapture,
    socket: Socket,
  ): void {
    if (
      device.platform === "ios" &&
      capture.lastIdleMs !== null &&
      capture.encodedSinceSourceFrame &&
      capture.lastEncodedBoundarySequence === capture.sourceFrameSequence &&
      this.timer.now() - capture.lastIdleMs <= SOURCE_EVIDENCE_MAX_AGE_MS
    ) {
      this.replayKeyFrame(capture, socket, device.deviceId);
    }
  }

  /**
   * Deliver one framed packet to a single subscriber, honoring the destroyed/backpressured/
   * awaiting-keyframe gates. Extracted from [broadcastNal] so that method stays under the
   * cyclomatic-complexity ratchet.
   */
  private writePacketToSubscriber(
    deviceId: string,
    capture: DeviceCapture,
    subscriber: Socket,
    { packet, isConfig, isKeyFrame }: { packet: Buffer; isConfig: boolean; isKeyFrame: boolean },
  ): void {
    if (subscriber.destroyed) {
      this.host.detach(subscriber);
      return;
    }
    if (this.shouldSkipPacket(capture, subscriber, isConfig, isKeyFrame)) {
      return;
    }
    if (!subscriber.write(packet)) {
      logger.debug(`[VideoStream] subscriber is behind on ${deviceId}; dropping to next key frame`);
      capture.backpressuredSubscribers.add(subscriber);
      capture.waitingForKeyFrame.add(subscriber);
      const onDrain = () => {
        const stall = this.outboundStalls.get(subscriber);
        if (!stall) {
          return;
        }
        this.timer.clearTimeout(stall.timeout);
        this.outboundStalls.delete(subscriber);
        const current = this.host.getCapture(deviceId);
        if (current !== capture || !current.subscribers.has(subscriber)) {
          return;
        }
        current.backpressuredSubscribers.delete(subscriber);
        // The subscriber caught up, but it is still waiting for an IDR to resync — every inter
        // frame is skipped until one arrives. The natural GOP can be seconds away
        // (KEY_I_FRAME_INTERVAL), which would freeze this subscriber's video that whole time even
        // though it is ready to receive. Ask the encoder for an immediate key frame so recovery
        // takes ~one round-trip instead. Idempotent enough: a burst of drains just coalesces into
        // one IDR at the encoder.
        this.requestKeyFrameForWaitingSubscriber(deviceId, subscriber);
      };
      const timeout = this.timer.setTimeout(() => {
        if (!this.outboundStalls.has(subscriber)) {
          return;
        }
        logger.warn(`[VideoStream] subscriber stalled on ${deviceId}; detaching`);
        this.host.detach(subscriber);
        subscriber.destroy();
      }, this.deps.outboundStallTimeoutMs ?? OUTBOUND_STALL_TIMEOUT_MS);
      this.outboundStalls.set(subscriber, { timeout, onDrain });
      subscriber.once("drain", onDrain);
    }
  }

  private shouldSkipPacket(
    capture: DeviceCapture,
    subscriber: Socket,
    isConfig: boolean,
    isKeyFrame: boolean,
  ): boolean {
    if (
      capture.waitingForReplacement.has(subscriber) ||
      capture.backpressuredSubscribers.has(subscriber)
    ) {
      return true;
    }
    if (!capture.waitingForKeyFrame.has(subscriber)) {
      return false;
    }
    // Keep configuration flowing while waiting for an IDR. An IDR from a replacement encoder
    // is not decodable until its parameter sets have arrived.
    if (!isKeyFrame) {
      return !isConfig;
    }
    if (capture.generation > 0 && (!capture.sps || !capture.pps)) {
      return true;
    }
    capture.waitingForKeyFrame.delete(subscriber);
    return false;
  }

  /**
   * Ask the capture source for an immediate key frame on behalf of a subscriber waiting to resync,
   * retrying through the injected timer while the request is throttled.
   *
   * `requestKeyFrame()` returns false when the source is rate-limiting requests (Android + raw iOS
   * gate them for ~3s, encoded iOS ~500ms). Ignoring that rejection leaves the subscriber in
   * `waitingForKeyFrame`, dropping every inter frame until the encoder's natural GOP — seconds of
   * frozen video, the very symptom this drain recovery exists to prevent. The retry self-terminates:
   * each attempt stops once the subscriber has resynced (left `waitingForKeyFrame`), disconnected,
   * or the capture is gone, and attempts are bounded so a source that never honors one cannot loop.
   */
  requestKeyFrameForWaitingSubscriber(
    deviceId: string,
    subscriber: Socket,
    attemptsLeft: number = KEY_FRAME_RETRY_MAX_ATTEMPTS,
  ): void {
    const capture = this.host.getCapture(deviceId);
    if (!capture) {
      return;
    }
    // Nothing to do once the subscriber left or already resynced on a key frame.
    if (subscriber.destroyed || !capture.waitingForKeyFrame.has(subscriber)) {
      return;
    }
    if (capture.waitingForReplacement.has(subscriber)) {
      return;
    }
    const source = capture.source;
    // A source without requestKeyFrame can't force one; only the natural GOP recovers it.
    if (!source?.requestKeyFrame) {
      return;
    }
    if (source.requestKeyFrame() || attemptsLeft <= 0) {
      return;
    }
    this.timer.setTimeout(
      () => this.requestKeyFrameForWaitingSubscriber(deviceId, subscriber, attemptsLeft - 1),
      KEY_FRAME_RETRY_INTERVAL_MS,
    );
  }

  private replayParameterSets(capture: DeviceCapture, socket: Socket): void {
    const parameterSets = [capture.sps, capture.pps].filter((nal): nal is Buffer => nal !== null);
    if (parameterSets.length === 0) {
      return;
    }
    const payload = Buffer.concat(parameterSets.flatMap((nal) => [ANNEX_B_START_CODE, nal]));
    // Replayed parameter sets carry the current rotation too, so a late joiner never applies a
    // stale orientation before the next live config packet (issue #4786).
    socket.write(
      encodePacket(
        encodePtsAndFlags(this.deps.nowUs(), { isConfig: true, rotation: capture.rotation }),
        payload,
      ),
    );
  }

  /** Remove the media drain guard when the server detaches a subscriber. */
  clearSubscriberStall(socket: Socket): void {
    const stall = this.outboundStalls.get(socket);
    if (stall) {
      this.timer.clearTimeout(stall.timeout);
      socket.off("drain", stall.onDrain);
      this.outboundStalls.delete(socket);
    }
  }

  /**
   * Start the relay-originated heartbeat (issue #7549): a zero-payload packet on the injected
   * timer, sent every `HEARTBEAT_INTERVAL_MS` to every promoted, non-backpressured subscriber
   * while the capture has recent source output. A subscriber still `waitingForKeyFrame` is skipped, same
   * as any other packet — see `writePacketToSubscriber`.
   */
  private startHeartbeat(deviceId: string, capture: DeviceCapture): void {
    capture.heartbeatTimer = this.timer.setInterval(() => {
      if (this.host.getCapture(deviceId) !== capture || !capture.source) {
        return;
      }
      if (!this.hasFreshSourceEvidence(deviceId, capture)) {
        // A reconnect must never inherit a capture we have already declared stale.
        // stopCapture removes it synchronously and serializes replacement behind source.stop().
        if (this.host.getCapture(deviceId) === capture) {
          void this.host.stopCapture(deviceId, true);
        }
        return;
      }
      // A lone stage needs recent native idle evidence to attest live video.
      if (
        capture.lastEncodedDataMs === null ||
        (capture.lastSourceDataMs === null && !this.idleEvidenceIsRecent(capture, this.timer.now()))
      ) {
        return;
      }
      const packet = encodeHeartbeat();
      for (const subscriber of capture.subscribers) {
        if (
          subscriber.destroyed ||
          capture.waitingForKeyFrame.has(subscriber) ||
          capture.backpressuredSubscribers.has(subscriber)
        ) {
          continue;
        }
        subscriber.write(packet);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private hasFreshSourceEvidence(deviceId: string, capture: DeviceCapture): boolean {
    if (capture.lastSourceDataMs === null || capture.lastEncodedDataMs === null) {
      return this.incompleteEvidenceIsRecent(capture);
    }
    return this.hasFreshCompleteSourceEvidence(deviceId, capture);
  }

  private incompleteEvidenceIsRecent(capture: DeviceCapture): boolean {
    const now = this.timer.now();
    return (
      capture.source !== null &&
      capture.firstEvidenceMs !== null &&
      (this.idleEvidenceIsRecent(capture, now) ||
        now - capture.firstEvidenceMs < SOURCE_EVIDENCE_MAX_AGE_MS)
    );
  }

  private hasFreshCompleteSourceEvidence(deviceId: string, capture: DeviceCapture): boolean {
    const { source, lastSourceDataMs, lastEncodedDataMs } = capture;
    if (!source || lastSourceDataMs === null || lastEncodedDataMs === null) {
      return false;
    }
    const now = this.timer.now();
    if (this.sourceEvidenceIsRecent(capture, now) && capture.lastIdleMs !== null) {
      return true;
    }
    const oldestEvidenceAgeMs = Math.max(now - lastSourceDataMs, now - lastEncodedDataMs, 0);
    if (
      oldestEvidenceAgeMs >= SOURCE_PROBE_AFTER_MS &&
      (capture.lastLivenessProbeMs === null ||
        now - capture.lastLivenessProbeMs >= SOURCE_PROBE_AFTER_MS)
    ) {
      try {
        if (source.requestKeyFrame?.("probe")) {
          capture.lastLivenessProbeMs = now;
        }
      } catch (error) {
        logger.warn(`[VideoStream] liveness key-frame request failed for ${deviceId}: ${error}`);
      }
    }
    return this.sourceEvidenceIsRecent(capture, now);
  }

  /** Telemetry must not refresh the desktop's activity clock after producer or encoder stalls. */
  private sourceEvidenceIsRecent(capture: DeviceCapture, now: number): boolean {
    if (capture.lastSourceDataMs === null || capture.lastEncodedDataMs === null) {
      return false;
    }
    if (capture.legacySimulatorHelper) {
      return true;
    }
    if (this.idleEvidenceIsRecent(capture, now)) {
      return true;
    }
    return (
      Math.max(now - capture.lastSourceDataMs, now - capture.lastEncodedDataMs, 0) <=
      SOURCE_EVIDENCE_MAX_AGE_MS
    );
  }

  private idleEvidenceIsRecent(capture: DeviceCapture, now: number): boolean {
    return (
      capture.lastIdleMs !== null &&
      capture.encodedSinceSourceFrame &&
      now - capture.lastIdleMs <= SOURCE_EVIDENCE_MAX_AGE_MS
    );
  }

  /** A stalled per-source encoder must not retire a producer shared by other leases. */
  producerEvidenceIsStale(capture: DeviceCapture): boolean {
    const now = this.timer.now();
    return (
      (capture.lastSourceDataMs === null ||
        now - capture.lastSourceDataMs > SOURCE_EVIDENCE_MAX_AGE_MS) &&
      (capture.lastIdleMs === null || now - capture.lastIdleMs > SOURCE_EVIDENCE_MAX_AGE_MS)
    );
  }

  clearHeartbeatTimer(capture: DeviceCapture): void {
    if (capture.heartbeatTimer) {
      this.timer.clearInterval(capture.heartbeatTimer);
      capture.heartbeatTimer = null;
    }
  }
}
