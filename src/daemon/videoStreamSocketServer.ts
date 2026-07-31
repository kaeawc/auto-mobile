import type { Socket } from "node:net";
import { logger } from "../utils/logger";
import { toActionableError } from "../models/ActionableError";
import { ActionableError } from "../models";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import { createH264CaptureSource } from "../features/webrtc/h264CaptureSourceFactory";
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
  bitrateBps?: number;
  size?: { width: number; height: number };
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
}

const ANNEX_B_START_CODE = Buffer.from([0, 0, 0, 1]);

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
    return this.captures.get(deviceId)?.subscribers.size ?? 0;
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
    } catch (error) {
      logger.warn(`[VideoStream] subscribe failed: ${error}`);
      this.sendJson(socket, {
        id: request.id,
        type: "video_stream_response",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies VideoStreamSocketResponse);
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
      existing.subscribers.add(socket);
      // A client that joins part way through a GOP must not consume inter frames before an IDR.
      existing.waitingForKeyFrame.add(socket);
      this.socketDeviceIds.set(socket, deviceId);
      return existing;
    }

    const capture: DeviceCapture = {
      source: null,
      subscribers: new Set([socket]),
      backpressuredSubscribers: new Set(),
      waitingForKeyFrame: new Set(),
      sps: null,
      pps: null,
      parser: new H264AnnexBParser(),
      size: request.size,
    };
    // Registered before start() so a chunk arriving during startup still finds its subscribers.
    this.captures.set(deviceId, capture);
    this.socketDeviceIds.set(socket, deviceId);

    try {
      const source = await this.deps.createCaptureSource({
        device,
        onData: chunk => this.broadcast(deviceId, chunk),
        onError: error => {
          logger.warn(`[VideoStream] capture failed for ${deviceId}: ${error}`);
          void this.stopCapture(deviceId);
        },
        bitrateBps: request.bitrateKbps ? request.bitrateKbps * 1000 : undefined,
        size: request.size,
        // Pin the observation rate explicitly. This relay borrows the WebRTC
        // capture sources, so without this it would silently inherit whatever
        // the *WebRTC* iOS Simulator default happens to be — a knob that is
        // tuned for an interactive WHEP feed and is not configurable here.
        fps: SIMULATOR_FPS_DEFAULT,
      });
      // The final subscriber may disconnect while source construction is in
      // flight. Do not attach an unreachable capture process to a removed entry.
      if (this.captures.get(deviceId) !== capture || capture.subscribers.size === 0) {
        await source.stop().catch(() => {});
        throw new ActionableError(`Video capture for ${deviceId} was stopped during startup.`);
      }
      capture.source = source;
      await source.start();
      if (this.captures.get(deviceId) !== capture || capture.subscribers.size === 0) {
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
      this.socketDeviceIds.delete(socket);
      throw toActionableError(error, `Failed to start video capture for ${deviceId}`);
    }

    return capture;
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
    const packet = encodePacket(
      encodePtsAndFlags(this.deps.nowUs(), { isConfig, isKeyFrame }),
      Buffer.concat([ANNEX_B_START_CODE, nal])
    );

    for (const subscriber of capture.subscribers) {
      if (subscriber.destroyed) {
        this.detach(subscriber);
        continue;
      }
      if (capture.backpressuredSubscribers.has(subscriber)) {continue;}
      if (capture.waitingForKeyFrame.has(subscriber)) {
        // Keep codec configuration flowing while waiting for an IDR. A late
        // join can occur after SPS but before PPS, and suppressing PPS leaves
        // the otherwise complete IDR undecodable.
        if (!isKeyFrame && !isConfig) {continue;}
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
          current?.backpressuredSubscribers.delete(subscriber);
        });
      }
    }
  }

  private replayParameterSets(capture: DeviceCapture, socket: Socket): void {
    const parameterSets = [capture.sps, capture.pps].filter((nal): nal is Buffer => nal !== null);
    if (parameterSets.length === 0) {return;}
    const payload = Buffer.concat(parameterSets.flatMap(nal => [ANNEX_B_START_CODE, nal]));
    socket.write(encodePacket(encodePtsAndFlags(this.deps.nowUs(), { isConfig: true }), payload));
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
    capture.subscribers.delete(socket);
    capture.backpressuredSubscribers.delete(socket);
    capture.waitingForKeyFrame.delete(socket);
    if (capture.subscribers.size === 0) {
      void this.stopCapture(deviceId);
    }
  }

  private async stopCapture(deviceId: string): Promise<void> {
    const capture = this.captures.get(deviceId);
    if (!capture) {
      return;
    }
    this.captures.delete(deviceId);

    for (const subscriber of capture.subscribers) {
      this.socketDeviceIds.delete(subscriber);
      subscriber.end();
    }
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
      return createH264CaptureSource(options, jarPath);
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
