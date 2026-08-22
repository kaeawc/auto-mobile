import { errorMessage } from "../utils/describeUnknownError";
import type { Socket } from "node:net";
import { logger } from "../utils/logger";
import { toActionableError } from "../models/ActionableError";
import { ActionableError } from "../models";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import {
  createH264CaptureSource,
} from "../features/webrtc/h264CaptureSourceFactory";
import { ScreenRecordingPermissionError } from "../features/webrtc/IosH264Source";
import { resolveVideoServerJar } from "../features/webrtc/videoServerJar";
import { SIMULATOR_FPS_DEFAULT } from "../features/screen-stream/IOSScreenCaptureHelper";
import type { BootedDevice } from "../models";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import type { H264CaptureSource } from "../features/webrtc/H264CaptureSource";
import { H264AnnexBParser, nalUnitType, NAL_TYPE_IDR, NAL_TYPE_PPS, NAL_TYPE_SPS } from "../features/webrtc/h264";
import { VIDEO_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import { BaseSocketServer, getSocketPath } from "./socketServer/index";
import {
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import {
  encodePacket,
  encodePtsAndFlags,
  encodeStreamHeader,
} from "./videoStreamFraming";
import type { VideoStreamSocketRequest, VideoStreamSocketResponse } from "./videoStreamSocketTypes";

/** Creates the capture source for a device. Injected so tests never touch adb. */
export type CaptureSourceFactory = (options: {
  device: BootedDevice;
  onData: (chunk: Buffer) => void;
  onError: (error: Error) => void;
  /** Receives the attested display rotation (0..3) when the source can prove it (issue #4786). */
  onRotation?: (rotation: number) => void;
  bitrateBps?: number;
  size?: { width: number; height: number };
  /** Aspect-preserving resolution/bitrate preset; see `VideoStreamSocketRequest.quality`. */
  quality?: "low" | "medium" | "high";
  /** Capture rate for iOS Simulator sources; see the call site for why it is pinned. */
  fps?: number;
}) => Promise<H264CaptureSource>;

export interface VideoStreamSocketServerDependencies {
  createCaptureSource: CaptureSourceFactory;
  resolveDevice: (deviceId?: string) => Promise<BootedDevice>;
  /** Monotonic microseconds, used for packet presentation timestamps. */
  nowUs: () => bigint;
}

/** One capture shared by every subscriber watching the same device. */
interface DeviceCapture {
  source: H264CaptureSource | null;
  /** Resolves only after the shared source has started, so late subscribers share startup failures. */
  startup: Promise<void>;
  /** Sockets waiting for startup, kept off the binary broadcast path until their acknowledgement. */
  pendingSubscribers: Set<Socket>;
  subscribers: Set<Socket>;
  backpressuredSubscribers: Set<Socket>;
  waitingForKeyFrame: Set<Socket>;
  /**
   * Most recent parameter sets (SPS/PPS). A client that joins mid-stream cannot decode until it
   * sees these, and the encoder only re-emits them on key frames.
   */
  sps: Buffer | null;
  pps: Buffer | null;
  parser: H264AnnexBParser;
  size?: { width: number; height: number };
  /**
   * Latest attested display rotation (0..3) from the source, or null when the source cannot attest
   * it (screenrecord/iOS) or none has arrived yet (issue #4786). Re-emitted on every config packet
   * the relay writes so a late joiner or a post-rotation client sees the current orientation.
   */
  rotation: number | null;
}

const ANNEX_B_START_CODE = Buffer.from([0, 0, 0, 1]);

const SUPPORTED_QUALITIES = new Set(["low", "medium", "high"]);
// The relay resolves the device only after this validation, so it bounds fps to the range every
// capture backend can honor rather than a per-platform limit. The iOS Simulator helper is the
// tightest at [5, 60] (SIMULATOR_FPS_MIN/MAX); the Android video-server accepts any positive
// rate, so [5, 60] is the safe universal window — a hint outside it would pass here and then throw
// at iOS capture startup.
const MIN_FPS_HINT = 5;
const MAX_FPS_HINT = 60;
// A generous encoder ceiling (~1 Gbps) that still leaves headroom below Number.MAX_SAFE_INTEGER
// after the kbps→bps ×1000 conversion at the capture-options boundary, so a huge-but-finite hint
// cannot silently lose integer precision downstream.
const MAX_BITRATE_KBPS = 1_000_000;

// A key-frame request can be rejected when the capture source is rate-limiting them (Android and
// raw iOS gate requests for ~3s, encoded iOS for ~500ms). When one is throttled we retry on the
// injected timer instead of leaving the subscriber frozen until the encoder's natural GOP. The
// interval × attempts span the widest (~3s) throttle window with headroom.
const KEY_FRAME_RETRY_INTERVAL_MS = 500;
const KEY_FRAME_RETRY_MAX_ATTEMPTS = 8;

/**
 * Captures are shared per device and the FIRST subscriber's hints fixed the encode; a late
 * joiner's differing quality/fps/bitrate hints are silently ignored, so leave a trace for the
 * viewer wondering why its preset didn't apply.
 */
function logIgnoredLateHints(deviceId: string, request: VideoStreamSocketRequest): void {
  if (request.quality || request.fps || request.bitrateKbps) {
    logger.debug(
      `[VideoStream] ${deviceId} already captured; ignoring late subscriber hints ` +
        `(quality=${request.quality}, fps=${request.fps}, bitrateKbps=${request.bitrateKbps})`
    );
  }
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateQuality(quality: VideoStreamSocketRequest["quality"]): string | null {
  return quality === undefined || SUPPORTED_QUALITIES.has(quality)
    ? null
    : `Unsupported quality "${quality}"; expected low, medium, or high.`;
}

function validateFps(fps: VideoStreamSocketRequest["fps"]): string | null {
  return fps === undefined || isIntegerInRange(fps, MIN_FPS_HINT, MAX_FPS_HINT)
    ? null
    : `Invalid fps ${fps}; expected an integer between ${MIN_FPS_HINT} and ${MAX_FPS_HINT}.`;
}

function validateBitrate(bitrateKbps: VideoStreamSocketRequest["bitrateKbps"]): string | null {
  return bitrateKbps === undefined || isIntegerInRange(bitrateKbps, 1, MAX_BITRATE_KBPS)
    ? null
    : `Invalid bitrateKbps ${bitrateKbps}; expected an integer between 1 and ${MAX_BITRATE_KBPS}.`;
}

function validateSize(size: VideoStreamSocketRequest["size"]): string | null {
  if (size === undefined) {
    return null;
  }
  const { width, height } = size ?? {};
  return isIntegerInRange(width, 2, Number.MAX_SAFE_INTEGER) &&
    isIntegerInRange(height, 2, Number.MAX_SAFE_INTEGER)
    ? null
    : `Invalid size ${JSON.stringify(size)}; expected integer width/height >= 2.`;
}

/**
 * Validate the optional capture hints on a subscribe request, returning an error message for the
 * first invalid field or null when all hints are usable. TypeScript's wire types are erased at
 * runtime, so this is the only thing standing between a malformed hint and the encoder argv.
 */
export function validateCaptureHints(request: VideoStreamSocketRequest): string | null {
  return (
    validateQuality(request.quality) ??
    validateFps(request.fps) ??
    validateBitrate(request.bitrateKbps) ??
    validateSize(request.size)
  );
}

function subscribeFailureResponse(
  requestId: string | undefined,
  error: unknown
): VideoStreamSocketResponse {
  if (error instanceof ScreenRecordingPermissionError) {
    return {
      id: requestId,
      type: "video_stream_response",
      success: false,
      permission: {
        kind: "screen_recording",
        status: "needs_approval",
        approvalTarget: error.approvalTarget,
      },
      // Keep pre-permission desktop clients actionable during rolling updates.
      error: error.message,
    };
  }
  return {
    id: requestId,
    type: "video_stream_response",
    success: false,
    error: errorMessage(error),
  };
}

/**
 * Relays a device's live H.264 stream to local clients over `~/.auto-mobile/video-stream.sock`.
 *
 * This is the local live-mirroring path, deliberately separate from the WebRTC/WHIP publisher —
 * that one pushes to a remote coordination server for browser viewers and exposes no playback URL,
 * so it cannot serve a viewer running on this machine.
 *
 * The handshake is one JSON line in and one JSON line out, which is why this extends
 * [BaseSocketServer] like every other daemon socket. Everything after the acknowledgement is raw
 * binary in the `VideoStreamProtocol` framing the on-device encoder already speaks, so a 4–8 Mbps
 * stream does not pay a ~33% base64 tax per frame. That is the one place this server departs from
 * the newline-JSON convention, and it is why it writes to the socket directly instead of through
 * `sendJson`.
 *
 * One capture is shared by every subscriber watching the same device, so a second viewer does not
 * start a second encoder; the capture stops when the last subscriber for that device disconnects.
 */
export class VideoStreamSocketServer extends BaseSocketServer {
  private readonly captures = new Map<string, DeviceCapture>();
  private readonly socketDeviceIds = new Map<Socket, string>();

  private readonly authenticator: StreamSocketAuthenticator;

  constructor(
    private readonly deps: VideoStreamSocketServerDependencies,
    socketPath: string = getSocketPath(VIDEO_STREAM_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator("video-stream subscribe")
  ) {
    // Idle timeout disabled: this stream is outbound-only after the handshake, and a viewer that
    // never sends another byte is the normal case, not a dead peer.
    super(socketPath, timer, "VideoStream", 0);
    this.authenticator = authenticator;
  }

  /** Devices with an active capture, for diagnostics and tests. */
  activeDeviceIds(): string[] {
    return [...this.captures.keys()];
  }

  /** Subscriber count for a device, for diagnostics and tests. */
  subscriberCount(deviceId: string): number {
    const capture = this.captures.get(deviceId);
    return capture ? capture.pendingSubscribers.size + capture.subscribers.size : 0;
  }

  override async close(): Promise<void> {
    for (const deviceId of [...this.captures.keys()]) {
      await this.stopCapture(deviceId);
    }
    this.socketDeviceIds.clear();
    await super.close();
  }

  protected async processLine(socket: Socket, line: string): Promise<void> {
    if (this.socketDeviceIds.has(socket)) {
      // Already streaming; clients send nothing else, so ignore stray input rather than
      // interrupting the stream.
      return;
    }

    const request = this.parseJson<VideoStreamSocketRequest>(line);
    if (!request) {
      this.sendJson(socket, {
        type: "video_stream_response",
        success: false,
        error: "Invalid JSON",
      } satisfies VideoStreamSocketResponse);
      socket.end();
      return;
    }

    if (request.action !== "subscribe") {
      this.sendJson(socket, {
        id: request.id,
        type: "video_stream_response",
        success: false,
        error: `Unsupported video stream action: ${request.action}`,
      } satisfies VideoStreamSocketResponse);
      socket.end();
      return;
    }

    // parseJson is a cast, not a validator: a hostile or skewed client can put anything in the
    // hint fields. An unknown quality would NaN out capToQualityPreset into `--size 0xundefined`
    // (dead capture, confusing error) and a non-positive fps/bitrate would reach the encoders
    // verbatim, so refuse the subscribe up front with a message naming the bad field.
    const hintError = validateCaptureHints(request);
    if (hintError) {
      this.sendJson(socket, {
        id: request.id,
        type: "video_stream_response",
        success: false,
        error: hintError,
      } satisfies VideoStreamSocketResponse);
      socket.end();
      return;
    }

    try {
      // Authenticate before starting or attaching to any capture (issue #4751):
      // an unauthenticated or cross-session subscribe is rejected here so it can
      // never ride along on the raw H.264 screen stream.
      this.authenticator.authorize({ sessionUuid: request.sessionUuid, deviceId: request.deviceId });
      const device = await this.deps.resolveDevice(request.deviceId);
      const capture = await this.attach(socket, device, request);

      this.sendJson(socket, {
        id: request.id,
        type: "video_stream_response",
        success: true,
        action: "subscribe",
        deviceId: device.deviceId,
        framing: "h264",
      } satisfies VideoStreamSocketResponse);

      socket.write(encodeStreamHeader(capture.size?.width ?? 0, capture.size?.height ?? 0));

      // Replay the parameter sets so a late joiner can decode immediately instead of waiting for
      // the encoder's next key frame.
      this.replayParameterSets(capture, socket);
      // Startup can synchronously emit an IDR before the acknowledgement makes this socket
      // eligible for binary data. Gate the subscriber and ask for a post-ack keyframe so it
      // never begins on an undecodable inter-frame. Retried through the injected timer when the
      // source throttles the request (same helper as the drain path): a bare call that lands
      // inside the throttle window (~3s Android/raw-iOS) would leave this just-promoted
      // subscriber parked in waitingForKeyFrame until the encoder's natural GOP — which on an
      // idle screen is exactly the frozen-pane-on-reconnect symptom.
      this.requestKeyFrameForWaitingSubscriber(device.deviceId, socket);
    } catch (error) {
      logger.warn(`[VideoStream] subscribe failed: ${error}`);
      this.detach(socket);
      this.sendJson(socket, subscribeFailureResponse(request.id, error));
      socket.end();
    }
  }

  protected override onConnectionClose(socket: Socket): void {
    this.detach(socket);
  }

  protected override onConnectionError(socket: Socket, _error: Error): void {
    this.detach(socket);
  }

  private async attach(
    socket: Socket,
    device: BootedDevice,
    request: VideoStreamSocketRequest
  ): Promise<DeviceCapture> {
    const deviceId = device.deviceId;
    const existing = this.captures.get(deviceId);
    if (existing) {
      logIgnoredLateHints(deviceId, request);
      existing.pendingSubscribers.add(socket);
      this.socketDeviceIds.set(socket, deviceId);
      await existing.startup;
      this.promoteSubscriber(existing, socket, true);
      return existing;
    }

    const capture: DeviceCapture = {
      source: null,
      startup: Promise.resolve(),
      pendingSubscribers: new Set([socket]),
      subscribers: new Set(),
      backpressuredSubscribers: new Set(),
      waitingForKeyFrame: new Set(),
      sps: null,
      pps: null,
      parser: new H264AnnexBParser(),
      size: request.size,
      rotation: null,
    };
    // Registered before start() so a chunk arriving during startup still finds its subscribers.
    this.captures.set(deviceId, capture);
    this.socketDeviceIds.set(socket, deviceId);

    capture.startup = (async () => {
      try {
        const source = await this.deps.createCaptureSource({
          device,
          onData: chunk => this.broadcast(deviceId, chunk),
          // Record the source's attested rotation so the next config packet re-attests it to
          // subscribers, including a late joiner via replayParameterSets (issue #4786).
          onRotation: rotation => {
            const current = this.captures.get(deviceId);
            if (current) {
              current.rotation = rotation;
            }
          },
          onError: error => {
            logger.warn(`[VideoStream] capture failed for ${deviceId}: ${error}`);
            void this.stopCapture(deviceId);
          },
          bitrateBps: request.bitrateKbps ? request.bitrateKbps * 1000 : undefined,
          size: request.size,
          quality: request.quality,
          // Pin the observation rate explicitly when the client sent no hint. This
          // relay borrows the WebRTC capture sources, so without this it would
          // silently inherit whatever the *WebRTC* iOS Simulator default happens
          // to be — a knob that is tuned for an interactive WHEP feed. A client
          // hint wins so farm viewers can lower the rate across many streams.
          fps: request.fps ?? SIMULATOR_FPS_DEFAULT,
        });
        // The final subscriber may disconnect while source construction is in
        // flight. Do not attach an unreachable capture process to a removed entry.
        if (this.captures.get(deviceId) !== capture || !this.hasSubscribers(capture)) {
          await source.stop().catch(() => {});
          throw new ActionableError(`Video capture for ${deviceId} was stopped during startup.`);
        }
        capture.source = source;
        await source.start();
        if (this.captures.get(deviceId) !== capture || !this.hasSubscribers(capture)) {
          capture.source = null;
          await source.stop().catch(() => {});
          throw new ActionableError(`Video capture for ${deviceId} was stopped during startup.`);
        }
      } catch (error) {
        // A replacement subscriber may have installed a new capture while this
        // asynchronous start was unwinding. Never remove that newer capture.
        if (this.captures.get(deviceId) === capture) {
          this.captures.delete(deviceId);
        }
        throw toActionableError(error, `Failed to start video capture for ${deviceId}`);
      }
    })();

    await capture.startup;
    this.promoteSubscriber(capture, socket, true);
    return capture;
  }

  private hasSubscribers(capture: DeviceCapture): boolean {
    return capture.pendingSubscribers.size > 0 || capture.subscribers.size > 0;
  }

  private promoteSubscriber(capture: DeviceCapture, socket: Socket, waitForKeyFrame: boolean): void {
    if (socket.destroyed || !capture.pendingSubscribers.delete(socket)) {
      return;
    }
    capture.subscribers.add(socket);
    if (waitForKeyFrame) {
      // A client that joins part way through a GOP must not consume inter frames before an IDR.
      // The immediate key-frame request that unfreezes it lives in the subscribe-ack path (which
      // runs for late joiners too); the backpressure-drain recovery is handled in the drain handler.
      capture.waitingForKeyFrame.add(socket);
    }
  }

  private broadcast(deviceId: string, chunk: Buffer): void {
    const capture = this.captures.get(deviceId);
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
    const isConfig = type === NAL_TYPE_SPS || type === NAL_TYPE_PPS;
    if (type === NAL_TYPE_SPS) {capture.sps = Buffer.from(nal);}
    if (type === NAL_TYPE_PPS) {capture.pps = Buffer.from(nal);}

    const isKeyFrame = type === NAL_TYPE_IDR;
    // Attest the current rotation on config packets so a client can re-prove orientation from the
    // live stream alone after a rotation (issue #4786); non-config packets carry no rotation.
    const rotation = isConfig ? capture.rotation : null;
    const packet = encodePacket(
      encodePtsAndFlags(this.deps.nowUs(), { isConfig, isKeyFrame, rotation }),
      Buffer.concat([ANNEX_B_START_CODE, nal])
    );

    for (const subscriber of capture.subscribers) {
      this.writePacketToSubscriber(deviceId, capture, subscriber, packet, isConfig, isKeyFrame);
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
    packet: Buffer,
    isConfig: boolean,
    isKeyFrame: boolean
  ): void {
    if (subscriber.destroyed) {
      this.detach(subscriber);
      return;
    }
    if (capture.backpressuredSubscribers.has(subscriber)) {return;}
    if (capture.waitingForKeyFrame.has(subscriber)) {
      // Keep codec configuration flowing while waiting for an IDR. A late
      // join can occur after SPS but before PPS, and suppressing PPS leaves
      // the otherwise complete IDR undecodable.
      if (!isKeyFrame && !isConfig) {return;}
      if (isKeyFrame) {
        capture.waitingForKeyFrame.delete(subscriber);
      }
    }
    if (!subscriber.write(packet)) {
      logger.debug(`[VideoStream] subscriber is behind on ${deviceId}; dropping to next key frame`);
      capture.backpressuredSubscribers.add(subscriber);
      capture.waitingForKeyFrame.add(subscriber);
      subscriber.once("drain", () => {
        const current = this.captures.get(deviceId);
        if (!current) {return;}
        current.backpressuredSubscribers.delete(subscriber);
        // The subscriber caught up, but it is still waiting for an IDR to resync — every inter
        // frame is skipped until one arrives. The natural GOP can be seconds away
        // (KEY_I_FRAME_INTERVAL), which would freeze this subscriber's video that whole time even
        // though it is ready to receive. Ask the encoder for an immediate key frame so recovery
        // takes ~one round-trip instead. Idempotent enough: a burst of drains just coalesces into
        // one IDR at the encoder.
        this.requestKeyFrameForWaitingSubscriber(deviceId, subscriber);
      });
    }
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
  private requestKeyFrameForWaitingSubscriber(
    deviceId: string,
    subscriber: Socket,
    attemptsLeft: number = KEY_FRAME_RETRY_MAX_ATTEMPTS
  ): void {
    const capture = this.captures.get(deviceId);
    if (!capture) {return;}
    // Nothing to do once the subscriber left or already resynced on a key frame.
    if (subscriber.destroyed || !capture.waitingForKeyFrame.has(subscriber)) {return;}
    const source = capture.source;
    // A source without requestKeyFrame can't force one; only the natural GOP recovers it.
    if (!source?.requestKeyFrame) {return;}
    if (source.requestKeyFrame() || attemptsLeft <= 0) {return;}
    this.timer.setTimeout(
      () => this.requestKeyFrameForWaitingSubscriber(deviceId, subscriber, attemptsLeft - 1),
      KEY_FRAME_RETRY_INTERVAL_MS
    );
  }

  private replayParameterSets(capture: DeviceCapture, socket: Socket): void {
    const parameterSets = [capture.sps, capture.pps].filter((nal): nal is Buffer => nal !== null);
    if (parameterSets.length === 0) {return;}
    const payload = Buffer.concat(parameterSets.flatMap(nal => [ANNEX_B_START_CODE, nal]));
    // Replayed parameter sets carry the current rotation too, so a late joiner never applies a
    // stale orientation before the next live config packet (issue #4786).
    socket.write(
      encodePacket(
        encodePtsAndFlags(this.deps.nowUs(), { isConfig: true, rotation: capture.rotation }),
        payload
      )
    );
  }

  private detach(socket: Socket): void {
    const deviceId = this.socketDeviceIds.get(socket);
    if (!deviceId) {
      return;
    }
    this.socketDeviceIds.delete(socket);

    const capture = this.captures.get(deviceId);
    if (!capture) {
      return;
    }
    capture.pendingSubscribers.delete(socket);
    capture.subscribers.delete(socket);
    capture.backpressuredSubscribers.delete(socket);
    capture.waitingForKeyFrame.delete(socket);
    if (!this.hasSubscribers(capture)) {
      void this.stopCapture(deviceId);
    }
  }

  private async stopCapture(deviceId: string): Promise<void> {
    const capture = this.captures.get(deviceId);
    if (!capture) {
      return;
    }
    this.captures.delete(deviceId);

    for (const subscriber of [...capture.pendingSubscribers, ...capture.subscribers]) {
      this.socketDeviceIds.delete(subscriber);
      subscriber.end();
    }
    capture.pendingSubscribers.clear();
    capture.subscribers.clear();
    capture.backpressuredSubscribers.clear();
    capture.waitingForKeyFrame.clear();

    try {
      await capture.source?.stop();
    } catch (error) {
      // The capture is already detached, so a failure to tear down the device side is worth a
      // trace but must not propagate into socket teardown.
      logger.warn(`[VideoStream] failed to stop capture for ${deviceId}: ${error}`);
    }
  }
}

let socketServer: VideoStreamSocketServer | null = null;

export function getVideoStreamSocketPath(): string {
  return socketServer?.getSocketPath?.() ?? getSocketPath(VIDEO_STREAM_SOCKET_CONFIG);
}

export function setVideoStreamSocketServerForTesting(server: VideoStreamSocketServer | null): void {
  socketServer = server;
}

/**
 * Device resolution for the relay: an explicit id must match a connected device, and an omitted id
 * is only unambiguous when exactly one device is connected.
 */
async function defaultResolveDevice(deviceId?: string): Promise<BootedDevice> {
  const devices = await DeviceSessionManager.getInstance().detectConnectedPlatforms();

  if (deviceId) {
    const match = devices.find(device => device.deviceId === deviceId);
    if (!match) {
      throw new ActionableError(`No connected device with id ${deviceId}.`);
    }
    return match;
  }

  if (devices.length === 0) {
    throw new ActionableError("No connected devices found.");
  }
  if (devices.length > 1) {
    throw new ActionableError(
      `Multiple connected devices; specify deviceId. Found: ${devices
        .map(device => device.deviceId)
        .join(", ")}`
    );
  }
  return devices[0];
}

function defaultDependencies(): VideoStreamSocketServerDependencies {
  return {
    resolveDevice: defaultResolveDevice,
    createCaptureSource: async options => {
      // Resolved once per stream, off the frame path. A null jar means the Android source falls
      // back to `screenrecord`.
      const jarPath = await resolveVideoServerJar();
      return createH264CaptureSource(
        {
          device: options.device,
          onData: options.onData,
          onError: options.onError,
          onRotation: options.onRotation,
          bitrateBps: options.bitrateBps,
          size: options.size,
          quality: options.quality,
          fps: options.fps,
        },
        jarPath
      );
    },
    nowUs: () => BigInt(Math.round(performance.now() * 1000)),
  };
}

export async function startVideoStreamSocketServer(): Promise<void> {
  if (!socketServer) {
    socketServer = new VideoStreamSocketServer(defaultDependencies());
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
}

export async function stopVideoStreamSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}
