import {
  getDefaultDeviceCaptureRegistry,
  createDeviceCaptureRegistry,
  canRetainSharedCapture,
  stopStaleCapture,
  type DeviceCaptureRegistry,
} from "../features/webrtc/deviceCaptureRegistry";
import { SocketServerSingleton } from "./socketServerSingleton";
import { SessionReleaseBroadcaster } from "../server/sessionReleaseBroadcast";
import { ObserverReleaseBroadcaster, type ObserverReleaseSource } from "./observerReleaseBroadcast";
import {
  decideLifecycleEvent,
  decideOwnershipChange,
  subscriptionKindForIdentity,
  type StreamSubscriptionKind,
  type StreamSubscriptionIdentity,
  type StreamSubscriptionEndReason,
} from "./streamSubscriptionPolicy";
import {
  getDaemonStreamDeviceLifecycleEmitter,
  type StreamDeviceLifecycleEvents,
} from "./streamDeviceLifecycleEvents";
import { errorMessage } from "../utils/describeUnknownError";
import type { Socket } from "node:net";
import { logger } from "../utils/logger";
import { toActionableError } from "../models/ActionableError";
import { ActionableError } from "../models";
import { DeviceSessionManager } from "../devices/DeviceSessionManager";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import { createH264CaptureSource } from "../features/webrtc/h264CaptureSourceFactory";
import { ScreenRecordingPermissionError } from "../features/webrtc/IosH264Source";
import { resolveVideoServerJar } from "../features/webrtc/videoServerJar";
import { SIMULATOR_FPS_DEFAULT } from "../features/screen-stream/IosScreenCaptureHelper";
import { WEBRTC_ANDROID_FPS_DEFAULT } from "../features/webrtc/webrtcStreamingConfig";
import type { BootedDevice } from "../models";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import type { H264CaptureSource } from "../features/webrtc/H264CaptureSource";
import {
  H264AccessUnitAssembler,
  H264AnnexBParser,
  MAX_ANNEX_B_BUFFER_BYTES,
  nalUnitType,
  NAL_TYPE_IDR,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
} from "../features/webrtc/h264";
import { VIDEO_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import { BaseSocketServer, getSocketPath } from "./socketServer/index";
import {
  authorizeResolvedDevice,
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import { daemonDeviceAdmissionGate, type DeviceAdmissionGate } from "../utils/deviceAdmissionGate";
import { resolveStreamDevice } from "./streamDeviceResolver";
import { DaemonState } from "./daemonState";
import {
  encodeDroppedFrames,
  encodeHeartbeat,
  encodePacket,
  encodePtsAndFlags,
  encodeStreamHeader,
  encodeSubscriptionNotice,
} from "./videoStreamFraming";
import type { VideoStreamSocketRequest, VideoStreamSocketResponse } from "./videoStreamSocketTypes";

/** Creates the capture source for a device. Injected so tests never touch adb. */
export type CaptureSourceFactory = (options: {
  device: BootedDevice;
  onData: (chunk: Buffer) => void;
  /** Fresh producer frame; used by iOS where encoder output can replay a cached frame. */
  onSourceFrame?: () => void;
  /** Genuine native Simulator idle callback, scoped to this capture generation. */
  onSourceIdle?: () => void;
  onEncodedAccessUnit?: () => void;
  onIdleAttestationSupport?: (supported: boolean) => void;
  onError: (error: Error) => void;
  /** Receives the attested display rotation (0..3) when the source can prove it (issue #4786). */
  onRotation?: (rotation: number) => void;
  /** Receives cumulative source-side encoder drops for client quality control. */
  onDroppedFrames?: (droppedFrames: number) => void;
  bitrateBps?: number;
  size?: { width: number; height: number };
  /** Aspect-preserving resolution/bitrate preset; see `VideoStreamSocketRequest.quality`. */
  quality?: "low" | "medium" | "high";
  /** Capture rate for iOS Simulator sources; see the call site for why it is pinned. */
  fps?: number;
}) => Promise<H264CaptureSource>;

function defaultCaptureFps(device: BootedDevice): number {
  return device.platform === "android" ? WEBRTC_ANDROID_FPS_DEFAULT : SIMULATOR_FPS_DEFAULT;
}

function tracksConsumers(
  source: H264CaptureSource | null,
): source is H264CaptureSource & { setHasConsumers(hasConsumers: boolean): void } {
  return (
    source !== null && "setHasConsumers" in source && typeof source.setHasConsumers === "function"
  );
}

export interface VideoStreamSocketServerDependencies {
  createCaptureSource: CaptureSourceFactory;
  /** Share across transports by injection; omitted registries are local to this server. */
  captureRegistry?: DeviceCaptureRegistry;
  resolveDevice: (deviceId?: string, platform?: "android" | "ios") => Promise<BootedDevice>;
  /** Monotonic microseconds, used for packet presentation timestamps. */
  nowUs: () => bigint;
  ownershipChanges?: () => DeviceOwnershipChanges | null;
  deviceLifecycle?: () => StreamDeviceLifecycleEvents | null;
  /** Also covers device-less viewer sessions, whose release changes no device owner. */
  sessionReleases?: { subscribe(callback: (sessionId: string) => void): () => void };
  /** Released or expired observer registrations, which change no device owner (#11076). */
  observerReleases?: ObserverReleaseSource;
  /** Maximum time a subscriber may wait for outbound drain. */
  outboundStallTimeoutMs?: number;
}

/** The only session-manager event surface the relay needs. */
export interface DeviceOwnershipChanges {
  onDeviceOwnershipChange(callback: (deviceId: string) => void): () => void;
}

/** One capture shared by every subscriber watching the same device. */
interface DeviceCapture {
  device: BootedDevice;
  /** Latest explicit hint for each field wins; omitted fields retain their current value. */
  desiredHints: CaptureHints;
  appliedHints: CaptureHints;
  hintKind: StreamSubscriptionKind;
  /** Also identifies the SPS/PPS and GOP cache; both are cleared when this advances at swap. */
  generation: number;
  reconfigureTimer: NodeJS.Timeout | null;
  reconfiguring: Promise<void> | null;
  source: H264CaptureSource | null;
  /** Resolves only after the shared source has started, so late subscribers share startup failures. */
  startup: Promise<void>;
  /** Sockets waiting for startup, kept off the binary broadcast path until their acknowledgement. */
  pendingSubscribers: Set<Socket>;
  subscribers: Set<Socket>;
  backpressuredSubscribers: Set<Socket>;
  waitingForKeyFrame: Set<Socket>;
  /** Joiners held off the old encoder until the requested configuration is applied. */
  waitingForReplacement: Set<Socket>;
  /**
   * Most recent parameter sets (SPS/PPS). A client that joins mid-stream cannot decode until it
   * sees these, and the encoder only re-emits them on key frames.
   */
  sps: Buffer | null;
  pps: Buffer | null;
  parser: H264AnnexBParser;
  /** Bounded, complete IDR access unit for a late viewer of an unchanged screen. */
  keyFrameAssembler: H264AccessUnitAssembler;
  keyFrameAuBytes: number;
  latestKeyFrameAu: Buffer | null;
  latestInterFrameAus: Buffer[];
  cachedGopBytes: number;
  sourceFrameSequence: number;
  lastEncodedBoundarySequence: number | null;
  /**
   * Latest attested display rotation (0..3) from the source, or null when the source cannot attest
   * it (screenrecord/iOS) or none has arrived yet (issue #4786). Re-emitted on every config packet
   * the relay writes so a late joiner or a post-rotation client sees the current orientation.
   */
  rotation: number | null;
  idleTimer: NodeJS.Timeout | null;
  /**
   * Fires every `HEARTBEAT_INTERVAL_MS` once either pipeline stage reports data (issue #7549),
   * null before then and after teardown. A single stage arms retirement without sending packets.
   */
  heartbeatTimer: NodeJS.Timeout | null;
  /** First producer or encoder evidence; bounds startup when the other stage never reports. */
  firstEvidenceMs: number | null;
  /** Time of the latest fresh producer frame, never refreshed by replay or the relay. */
  lastSourceDataMs: number | null;
  /** Native producer-idle evidence; cleared by the next complete source frame. */
  lastIdleMs: number | null;
  /** An encoded chunk followed the most recent complete source frame. */
  encodedSinceSourceFrame: boolean;
  /** Temporary compatibility for a released helper without native idle markers. */
  legacySimulatorHelper: boolean;
  /** Time of the latest encoded output; both producer and encoder must keep making progress. */
  lastEncodedDataMs: number | null;
  /** Limits active key-frame probes while a source is quiet. A request is not proof of life. */
  lastLivenessProbeMs: number | null;
}

type CaptureHints = Pick<VideoStreamSocketRequest, "quality" | "fps" | "bitrateKbps" | "size">;

const ANNEX_B_START_CODE = Buffer.from([0, 0, 0, 1]);

/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const VIDEO_STREAM_PURPOSE = "to stream video";

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
// Covers brief viewer reconnects without keeping an abandoned encoder alive for long.
const CAPTURE_IDLE_GRACE_MS = 3_000;
const RECONFIGURE_DEBOUNCE_MS = 200;
const OUTBOUND_STALL_TIMEOUT_MS = 30_000;

/**
 * Cadence for the relay-originated heartbeat (issue #7549), also advertised to the client in the
 * subscribe ack (`heartbeatMs`) so it can size its own stall-reconnect window.
 */
const HEARTBEAT_INTERVAL_MS = 1_000;
// Give screenrecord and iOS's encoder time to answer a key-frame request before allowing the
// desktop's 10s stall watchdog to reconnect. A silent-but-attached process cannot extend this.
const SOURCE_PROBE_AFTER_MS = 6_000;
const SOURCE_EVIDENCE_MAX_AGE_MS = 9_000;

function subscriberMaySetCaptureHints(
  kind: StreamSubscriptionKind,
  identity?: StreamSubscriptionIdentity,
): boolean {
  return kind !== "viewer" || identity?.hasDeviceOwner === false;
}

function sameHints(left: CaptureHints, right: CaptureHints): boolean {
  return (
    left.quality === right.quality &&
    left.fps === right.fps &&
    left.bitrateKbps === right.bitrateKbps &&
    left.size?.width === right.size?.width &&
    left.size?.height === right.size?.height
  );
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
export function validateCaptureHints(
  request: Omit<VideoStreamSocketRequest, "platform"> & { platform?: unknown },
): string | null {
  return (
    validatePlatform(request.platform) ??
    validateQuality(request.quality) ??
    validateFps(request.fps) ??
    validateBitrate(request.bitrateKbps) ??
    validateSize(request.size)
  );
}

function validatePlatform(platform: unknown): string | null {
  return platform === undefined || platform === "android" || platform === "ios"
    ? null
    : `Invalid platform ${JSON.stringify(platform)}; expected "android" or "ios".`;
}

function subscribeFailureResponse(
  requestId: string | undefined,
  error: unknown,
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
 * start a second encoder; the capture stops after its last subscriber has been idle briefly.
 */
export class VideoStreamSocketServer extends BaseSocketServer {
  private readonly connections = new Set<Socket>();
  private readonly captures = new Map<string, DeviceCapture>();
  private readonly pendingStops = new Map<string, Promise<void>>();
  private readonly socketDeviceIds = new Map<Socket, string>();
  private readonly socketSessionUuids = new Map<Socket, string | undefined>();
  private readonly socketSubscriptionKinds = new Map<Socket, StreamSubscriptionKind>();
  private readonly acknowledgedSubscribers = new Set<Socket>();
  private removeDeviceRestoredListener: (() => void) | null = null;
  private removeDeviceRemovedListener: (() => void) | null = null;
  private removeIdentityChangedListener: (() => void) | null = null;
  private removeSessionReleaseListener: (() => void) | null = null;
  private removeObserverReleaseListener: (() => void) | null = null;
  private removeOwnershipListener: (() => void) | null = null;
  private readonly outboundStalls = new Map<
    Socket,
    { timeout: NodeJS.Timeout; onDrain: () => void }
  >();
  private readonly endingSockets = new Map<
    Socket,
    { timeout: NodeJS.Timeout; onClose: () => void }
  >();
  private readonly subscribing = new Set<Socket>();
  private closed = false;

  private readonly authenticator: StreamSocketAuthenticator;
  private readonly admissionGate: DeviceAdmissionGate;
  private readonly captureRegistry: DeviceCaptureRegistry;

  constructor(
    private readonly deps: VideoStreamSocketServerDependencies,
    socketPath: string = getSocketPath(VIDEO_STREAM_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    // Observers may watch read-only (#10698); admission is still viewer-only for non-holders.
    authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "video-stream subscribe",
      { allowObserverSessions: true },
    ),
    admissionGate: DeviceAdmissionGate = daemonDeviceAdmissionGate,
  ) {
    // Idle timeout disabled: this stream is outbound-only after the handshake, and a viewer that
    // never sends another byte is the normal case, not a dead peer.
    super(socketPath, timer, "VideoStream", 0);
    this.authenticator = authenticator;
    this.admissionGate = admissionGate;
    this.captureRegistry = deps.captureRegistry ?? createDeviceCaptureRegistry();
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

  override async start(): Promise<void> {
    await super.start();
    this.removeOwnershipListener =
      this.deps.ownershipChanges?.()?.onDeviceOwnershipChange((deviceId) => {
        this.reauthorizeSubscribers(deviceId);
      }) ?? null;
    // A viewer may watch a device other than its session's bound device, or have no binding.
    const reauthorizeAll = () => {
      for (const deviceId of this.captures.keys()) {
        this.reauthorizeSubscribers(deviceId);
      }
    };
    this.removeSessionReleaseListener =
      this.deps.sessionReleases?.subscribe(reauthorizeAll) ?? null;
    this.removeObserverReleaseListener =
      this.deps.observerReleases?.subscribe(reauthorizeAll) ?? null;
    this.subscribeDeviceLifecycle();
  }

  private subscribeDeviceLifecycle(): void {
    const lifecycle = this.deps.deviceLifecycle?.();
    this.removeDeviceRestoredListener =
      lifecycle?.onDeviceRestored((deviceId) => {
        this.endDeviceSubscribers(deviceId, "device_restored");
      }) ?? null;
    this.removeDeviceRemovedListener =
      lifecycle?.onDeviceRemoved((deviceId) => {
        this.endDeviceSubscribers(deviceId, "device_removed");
      }) ?? null;
    this.removeIdentityChangedListener =
      lifecycle?.onDeviceIdentityChanged((deviceId) => {
        if (!this.captures.has(deviceId)) {
          return;
        }
        try {
          this.admissionGate.assertDeviceActionable(deviceId, VIDEO_STREAM_PURPOSE);
        } catch (error) {
          // The admission gate is the authoritative quarantine check; lift/invalidation is a no-op.
          logger.warn(
            `[VideoStream] identity no longer actionable for ${deviceId}: ${errorMessage(error)}`,
          );
          this.endDeviceSubscribers(deviceId, "identity_quarantined");
        }
      }) ?? null;
  }

  override async close(): Promise<void> {
    this.closed = true;
    this.removeOwnershipListener?.();
    this.removeOwnershipListener = null;
    this.removeSessionReleaseListener?.();
    this.removeSessionReleaseListener = null;
    this.removeObserverReleaseListener?.();
    this.removeObserverReleaseListener = null;
    this.removeDeviceRestoredListener?.();
    this.removeDeviceRestoredListener = null;
    this.removeDeviceRemovedListener?.();
    this.removeIdentityChangedListener?.();
    this.removeDeviceRemovedListener = null;
    this.removeIdentityChangedListener = null;
    for (const deviceId of this.captures.keys()) {
      this.endDeviceSubscribers(deviceId, "daemon_shutdown");
    }
    await Promise.all([...this.captures.keys()].map((deviceId) => this.stopCapture(deviceId)));
    await Promise.all(this.pendingStops.values());
    this.socketDeviceIds.clear();
    this.socketSessionUuids.clear();
    this.socketSubscriptionKinds.clear();
    this.acknowledgedSubscribers.clear();
    this.subscribing.clear();
    // Subscription state can be detached before the transport finishes closing. Flush live
    // peers, then destroy even half-open connections, including unresolved/idle subscribers.
    for (const socket of this.connections) {
      this.endSocketBounded(socket);
    }
    try {
      await super.close();
    } finally {
      for (const { onClose } of this.endingSockets.values()) {
        onClose();
      }
    }
  }

  private isStreamingOrSubscribing(socket: Socket): boolean {
    return this.socketDeviceIds.has(socket) || this.subscribing.has(socket);
  }

  protected async processLine(socket: Socket, line: string): Promise<void> {
    if (socket.destroyed) {
      return;
    }
    if (this.isStreamingOrSubscribing(socket)) {
      // Policy classifies ALL post-handshake lines (even a second subscribe) as mutating for a
      // viewer. The relay has no control protocol: ignore them for both kinds without a reply.
      // assertMayControl provides a typed guard to transports with controls; a JSON error here
      // would corrupt the continuing binary framing. Subscribe-time hints remain admission data.
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

    this.subscribing.add(socket);
    try {
      // Authenticate before starting or attaching to any capture (issue #4751):
      // only a live device or observer session may subscribe; non-owners attach read-only.
      this.authenticator.authorize({
        sessionUuid: request.sessionUuid,
        deviceId: request.deviceId,
        admitViewer: true,
      });
      // FUNNEL 2, before any capture starts. Authorization is not this check:
      // the quarantine deliberately PRESERVES the owning session, so a subscribe
      // from it still authorizes while the pool can no longer say which AVD
      // answers on the serial — and a capture started on it would relay whatever
      // does ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
      // Gated twice because an omitted `deviceId` names its target only after
      // resolution, and the named serial must be refused before discovery runs.
      if (request.deviceId !== undefined) {
        this.admissionGate.assertDeviceActionable(request.deviceId, VIDEO_STREAM_PURPOSE);
      }
      const device = await this.deps.resolveDevice(request.deviceId, request.platform);
      this.admissionGate.assertDeviceActionable(device.deviceId, VIDEO_STREAM_PURPOSE);
      authorizeResolvedDevice(this.authenticator, {
        sessionUuid: request.sessionUuid,
        deviceId: device.deviceId,
        admitViewer: true,
      });
      const capture = await this.attach(socket, device, request);
      if (capture) {
        this.acknowledgeSubscriber(socket, capture, request);
      }
    } catch (error) {
      logger.warn(`[VideoStream] subscribe failed: ${error}`);
      this.detach(socket);
      if (!socket.destroyed) {
        this.sendJson(socket, subscribeFailureResponse(request.id, error));
        this.endSocketBounded(socket);
      }
    } finally {
      this.subscribing.delete(socket);
    }
  }

  /** Reconcile startup races before committing the JSON-to-binary transition. */
  private acknowledgeSubscriber(
    socket: Socket,
    capture: DeviceCapture,
    request: VideoStreamSocketRequest,
  ): void {
    // Ownership can change while the source starts. A revoked pending subscriber
    // must not receive a success acknowledgement or any binary stream data.
    if (!this.socketDeviceIds.has(socket)) {
      return;
    }
    if (!this.checkSubscriberActionable(socket, capture.device.deviceId)) {
      return;
    }
    if (this.authenticator.resolveSubscriptionIdentity) {
      this.reconcileSubscriber(socket, capture.device.deviceId);
    } else {
      authorizeResolvedDevice(this.authenticator, {
        sessionUuid: request.sessionUuid,
        deviceId: capture.device.deviceId,
        admitViewer: true,
      });
    }
    if (!this.socketDeviceIds.has(socket) || socket.destroyed) {
      return;
    }

    this.sendJson(socket, {
      id: request.id,
      type: "video_stream_response",
      success: true,
      action: "subscribe",
      deviceId: capture.device.deviceId,
      framing: "h264",
      heartbeatMs: HEARTBEAT_INTERVAL_MS,
      subscriptionKind: this.socketSubscriptionKinds.get(socket),
    } satisfies VideoStreamSocketResponse);

    if (socket.destroyed) {
      this.detach(socket);
      return;
    }
    socket.write(
      encodeStreamHeader(
        capture.appliedHints.size?.width ?? 0,
        capture.appliedHints.size?.height ?? 0,
      ),
    );
    this.acknowledgedSubscribers.add(socket);

    // The cache belongs to capture.generation. A joiner held for a future configuration must
    // not receive its old parameter sets or GOP, even though existing viewers still can.
    this.primeAcknowledgedSubscriber(capture, socket);
  }

  protected override onConnectionEstablished(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.connections.add(socket);
    // Bun may never emit finish/close for end() with queued notices after a peer disconnects.
    // A peer FIN cannot drain those writes; do not leave shutdown waiting on that socket.
    socket.once("end", () => socket.destroy());
  }

  protected override onConnectionClose(socket: Socket): void {
    this.connections.delete(socket);
    this.subscribing.delete(socket);
    this.detach(socket);
  }

  protected override onConnectionError(socket: Socket, _error: Error): void {
    this.subscribing.delete(socket);
    this.detach(socket);
  }

  private reauthorizeSubscribers(deviceId: string): void {
    const capture = this.captures.get(deviceId);
    if (!capture) {
      return;
    }
    for (const socket of [...capture.pendingSubscribers, ...capture.subscribers]) {
      this.reconcileSubscriber(socket, deviceId);
    }
  }

  private reconcileSubscriber(socket: Socket, deviceId: string): void {
    if (!this.socketDeviceIds.has(socket)) {
      return;
    }
    const kind = this.socketSubscriptionKinds.get(socket) ?? "owner";
    const input = { sessionUuid: this.socketSessionUuids.get(socket), deviceId };
    try {
      const identity = this.authenticator.resolveSubscriptionIdentity?.(input);
      if (!identity) {
        // Older injected authenticators retain strict revocation, without parsing error text.
        this.authenticator.authorize({ ...input, requireOwnership: true });
        return;
      }
      const decision = decideOwnershipChange({ ...identity, kind });
      if (decision.action === "end") {
        this.endSubscriber(socket, deviceId, decision.reason);
      } else if (decision.action === "downgrade") {
        this.socketSubscriptionKinds.set(socket, "viewer");
        logger.info(
          `[VideoStream] downgraded subscriber: deviceId=${deviceId} kind=viewer reason=downgrade`,
        );
        if (this.acknowledgedSubscribers.has(socket) && !socket.destroyed) {
          socket.write(encodeSubscriptionNotice("downgraded_to_viewer"));
        }
      }
    } catch (error) {
      // Fail closed; endSubscriber emits the warning without exposing the session identity.
      this.endSubscriber(socket, deviceId, "session_ended", { authorizationError: error });
    }
  }

  private endDeviceSubscribers(
    deviceId: string,
    event: Exclude<StreamSubscriptionEndReason, "session_ended" | "stopped_by_owner">,
  ): void {
    const capture = this.captures.get(deviceId);
    if (!capture) {
      return;
    }
    for (const socket of [...capture.pendingSubscribers, ...capture.subscribers]) {
      const kind = this.socketSubscriptionKinds.get(socket) ?? "owner";
      this.endSubscriber(socket, deviceId, decideLifecycleEvent({ kind, event }).reason);
    }
  }

  private endSubscriber(
    socket: Socket,
    deviceId: string,
    reason: Exclude<StreamSubscriptionEndReason, "stopped_by_owner">,
    options: { authorizationError?: unknown } = {},
  ): void {
    if (!this.socketDeviceIds.has(socket) && !this.subscribing.has(socket)) {
      return;
    }
    const kind = this.socketSubscriptionKinds.get(socket);
    const message = `[VideoStream] ending subscriber: deviceId=${deviceId} kind=${kind} reason=${reason}`;
    if (
      "authorizationError" in options ||
      reason === "device_removed" ||
      reason === "identity_quarantined"
    ) {
      logger.warn(message);
    } else {
      logger.info(message);
    }
    try {
      if (!socket.destroyed) {
        if (this.acknowledgedSubscribers.has(socket)) {
          socket.write(encodeSubscriptionNotice(reason));
        }
        this.sendJson(socket, {
          type: "video_stream_response",
          success: false,
          action: "unsubscribe",
          deviceId,
          terminal: true,
          reason,
          subscriptionKind: this.socketSubscriptionKinds.get(socket),
          error: `Video stream ended: ${reason} for ${deviceId}`,
        } satisfies VideoStreamSocketResponse);
        this.endSocketBounded(socket);
      }
    } catch (error) {
      logger.warn(`[VideoStream] failed to end subscriber for ${deviceId}: ${errorMessage(error)}`);
      if (!socket.destroyed) {
        socket.destroy();
      }
    } finally {
      this.subscribing.delete(socket);
      this.detach(socket);
    }
  }

  /** Ending must retain its own drain bound after detach clears the media stall timer. */
  private endSocketBounded(socket: Socket): void {
    if (socket.destroyed || this.endingSockets.has(socket)) {
      return;
    }
    const onClose = (): void => {
      const ending = this.endingSockets.get(socket);
      if (ending) {
        this.timer.clearTimeout(ending.timeout);
        this.endingSockets.delete(socket);
      }
      socket.off("close", onClose);
    };
    const timeout = this.timer.setTimeout(() => {
      socket.destroy();
    }, this.deps.outboundStallTimeoutMs ?? OUTBOUND_STALL_TIMEOUT_MS);
    this.endingSockets.set(socket, { timeout, onClose });
    socket.once("close", onClose);
    socket.end();
    socket.destroySoon();
  }

  private checkSubscriberActionable(socket: Socket, deviceId: string): boolean {
    try {
      this.admissionGate.assertDeviceActionable(deviceId, VIDEO_STREAM_PURPOSE);
      return true;
    } catch (error) {
      logger.warn(
        `[VideoStream] identity no longer actionable for ${deviceId}: ${errorMessage(error)}`,
      );
      this.endSubscriber(socket, deviceId, "identity_quarantined");
      return false;
    }
  }

  private async attach(
    socket: Socket,
    device: BootedDevice,
    request: VideoStreamSocketRequest,
  ): Promise<DeviceCapture | null> {
    if (this.closed) {
      throw new ActionableError("Video stream server is closed");
    }
    const deviceId = device.deviceId;
    const pendingStop = this.pendingStops.get(deviceId);
    if (pendingStop) {
      await pendingStop;
      if (this.closed) {
        throw new ActionableError("Video stream server is closed");
      }
      if (socket.destroyed) {
        throw new ActionableError(
          `Video stream subscriber disconnected while stopping ${deviceId}`,
        );
      }
    }
    // Recheck the live session after a pending stop; acquisition may now make it a viewer.
    authorizeResolvedDevice(this.authenticator, {
      sessionUuid: request.sessionUuid,
      deviceId: deviceId,
      admitViewer: true,
    });
    const identity = this.authenticator.resolveSubscriptionIdentity?.({
      sessionUuid: request.sessionUuid,
      deviceId,
    });
    const subscriptionKind = identity ? subscriptionKindForIdentity(identity) : "owner";
    this.socketSubscriptionKinds.set(socket, subscriptionKind);
    if (!this.checkSubscriberActionable(socket, deviceId)) {
      return null;
    }
    const existing = this.captures.get(deviceId);
    if (existing) {
      this.clearIdleTimer(existing);
      this.updateDesiredHints({ deviceId, capture: existing, request, identity, subscriptionKind });
      existing.pendingSubscribers.add(socket);
      if (tracksConsumers(existing.source)) {
        existing.source.setHasConsumers(true);
      }
      this.socketDeviceIds.set(socket, deviceId);
      this.socketSessionUuids.set(socket, request.sessionUuid);
      this.socketSubscriptionKinds.set(socket, subscriptionKind);
      await existing.startup;
      this.promoteSubscriber(existing, socket, true);
      this.scheduleReconfigure(deviceId, existing);
      return existing;
    }

    const hints: CaptureHints = subscriberMaySetCaptureHints(subscriptionKind, identity)
      ? request
      : {};
    const capture: DeviceCapture = {
      device,
      desiredHints: {
        quality: hints.quality,
        fps: hints.fps,
        bitrateKbps: hints.bitrateKbps,
        size: hints.size,
      },
      appliedHints: {
        quality: hints.quality,
        fps: hints.fps,
        bitrateKbps: hints.bitrateKbps,
        size: hints.size,
      },
      hintKind: subscriptionKind,
      generation: 0,
      reconfigureTimer: null,
      reconfiguring: null,
      source: null,
      startup: Promise.resolve(),
      pendingSubscribers: new Set([socket]),
      subscribers: new Set(),
      backpressuredSubscribers: new Set(),
      waitingForKeyFrame: new Set(),
      waitingForReplacement: new Set(),
      sps: null,
      pps: null,
      parser: new H264AnnexBParser(),
      keyFrameAssembler: new H264AccessUnitAssembler(),
      keyFrameAuBytes: 0,
      latestKeyFrameAu: null,
      latestInterFrameAus: [],
      cachedGopBytes: 0,
      sourceFrameSequence: 0,
      lastEncodedBoundarySequence: null,
      rotation: null,
      idleTimer: null,
      heartbeatTimer: null,
      firstEvidenceMs: null,
      lastSourceDataMs: null,
      lastIdleMs: null,
      encodedSinceSourceFrame: false,
      legacySimulatorHelper: false,
      lastEncodedDataMs: null,
      lastLivenessProbeMs: null,
    };
    // Registered before start() so a chunk arriving during startup still finds its subscribers.
    this.captures.set(deviceId, capture);
    this.socketDeviceIds.set(socket, deviceId);
    this.socketSessionUuids.set(socket, request.sessionUuid);
    this.socketSubscriptionKinds.set(socket, subscriptionKind);

    capture.startup = (async () => {
      try {
        const source = await this.createSource(capture, capture.appliedHints, capture.generation);
        // A final disconnect during construction arms the same idle grace as any
        // last-subscriber detach. Only a removed entry or expired grace aborts startup.
        if (
          this.captures.get(deviceId) !== capture ||
          (!this.hasSubscribers(capture) && !capture.idleTimer)
        ) {
          await source.stop().catch((error) => {
            logger.warn(`[VideoStream] failed to stop abandoned capture for ${deviceId}: ${error}`);
          });
          throw new ActionableError(`Video capture for ${deviceId} was stopped during startup.`);
        }
        capture.source = source;
        if (tracksConsumers(source)) {
          source.setHasConsumers(this.hasSubscribers(capture));
        }
        await source.start();
        if (
          this.captures.get(deviceId) !== capture ||
          (!this.hasSubscribers(capture) && !capture.idleTimer)
        ) {
          capture.source = null;
          await source.stop().catch((error) => {
            logger.warn(`[VideoStream] failed to stop abandoned capture for ${deviceId}: ${error}`);
          });
          throw new ActionableError(`Video capture for ${deviceId} was stopped during startup.`);
        }
      } catch (error) {
        this.clearHeartbeatTimer(capture);
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

  private async createSource(
    capture: DeviceCapture,
    hints: CaptureHints,
    generation: number,
  ): Promise<H264CaptureSource> {
    const { device } = capture;
    const deviceId = device.deviceId;
    const attestSource = (): void => {
      if (this.captures.get(deviceId) !== capture || capture.generation !== generation) {
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
      const current = this.captures.get(deviceId);
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
      hasConsumers: this.hasSubscribers(capture),
      flexibleHints: hints.fps === undefined ? ["fps"] : [],
      options: {
        device,
        onData: (chunk) => consumeData(chunk, true),
        onReplayData: (chunk) => consumeData(chunk, false),
        onSourceFrame: attestSource,
        onSourceIdle: () => {
          if (
            this.captures.get(deviceId) !== capture ||
            capture.generation !== generation ||
            !capture.encodedSinceSourceFrame
          ) {
            return;
          }
          capture.lastIdleMs = this.timer.now();
        },
        onEncodedAccessUnit: () => {
          if (this.captures.get(deviceId) !== capture || capture.generation !== generation) {
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
            this.captures.get(deviceId) === capture &&
            capture.generation === generation &&
            device.platform === "ios"
          ) {
            capture.legacySimulatorHelper = !supported;
          }
        },
        // Record the source's attested rotation so the next config packet re-attests it to
        // subscribers, including a late joiner via replayParameterSets (issue #4786).
        onRotation: (rotation) => {
          const current = this.captures.get(deviceId);
          if (current === capture && capture.generation === generation) {
            current.rotation = rotation;
          }
        },
        onDroppedFrames: (droppedFrames) => {
          const current = this.captures.get(deviceId);
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
            this.writePacketToSubscriber(deviceId, capture, subscriber, packet, false, false);
          }
        },
        onError: (error) => {
          if (this.captures.get(deviceId) === capture && capture.generation === generation) {
            logger.warn(`[VideoStream] capture failed for ${deviceId}: ${error}`);
            void this.stopCapture(deviceId);
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

  private updateDesiredHints({
    deviceId,
    capture,
    request,
    identity,
    subscriptionKind,
  }: {
    deviceId: string;
    capture: DeviceCapture;
    request: VideoStreamSocketRequest;
    identity?: StreamSubscriptionIdentity;
    subscriptionKind: StreamSubscriptionKind;
  }): void {
    // Read-only joiners cannot reconfigure an owner's shared encoder. Unowned
    // captures and auth-off retain the existing last-supplied-hint behavior.
    if (!subscriberMaySetCaptureHints(subscriptionKind, identity)) {
      return;
    }
    const takingOwnership = subscriptionKind === "owner" && capture.hintKind === "viewer";
    const desired: CaptureHints = takingOwnership ? {} : capture.desiredHints;
    if (subscriptionKind === "owner") {
      capture.hintKind = "owner";
    }
    capture.desiredHints = {
      quality: request.quality ?? desired.quality,
      fps: request.fps ?? desired.fps,
      bitrateKbps: request.bitrateKbps ?? desired.bitrateKbps,
      size: takingOwnership ? request.size : desired.size,
    };
    this.retainSharedHints(capture, capture.desiredHints);
    if (!sameHints(capture.desiredHints, capture.appliedHints)) {
      logger.info(`[VideoStream] ${deviceId} scheduling shared capture quality change`);
    }
    if (!this.reconfigurePending(capture)) {
      this.releaseReplacementWaiters(capture);
    }
  }

  private reconfigurePending(capture: DeviceCapture): boolean {
    return capture.reconfiguring !== null || !sameHints(capture.desiredHints, capture.appliedHints);
  }

  private primeSubscriber(capture: DeviceCapture, socket: Socket): void {
    this.replayParameterSets(capture, socket);
    this.replayCurrentIosKeyFrame(capture.device, capture, socket);
  }

  private primeAcknowledgedSubscriber(capture: DeviceCapture, socket: Socket): void {
    if (!this.reconfigurePending(capture)) {
      capture.waitingForReplacement.delete(socket);
      this.primeSubscriber(capture, socket);
    }
    // A source may have emitted before acknowledgement. Ask for a post-ack IDR when the
    // subscriber is allowed to consume this encoder; throttled requests use the retry path.
    this.requestKeyFrameForWaitingSubscriber(capture.device.deviceId, socket);
  }

  private releaseReplacementWaiters(capture: DeviceCapture): void {
    if (this.reconfigurePending(capture)) {
      return;
    }
    for (const subscriber of capture.waitingForReplacement) {
      if (!capture.subscribers.has(subscriber)) {
        continue;
      }
      capture.waitingForReplacement.delete(subscriber);
      this.primeSubscriber(capture, subscriber);
      this.requestKeyFrameForWaitingSubscriber(capture.device.deviceId, subscriber);
    }
  }

  private scheduleReconfigure(deviceId: string, capture: DeviceCapture): void {
    if (capture.reconfigureTimer) {
      this.timer.clearTimeout(capture.reconfigureTimer);
      capture.reconfigureTimer = null;
    }
    if (
      this.captures.get(deviceId) !== capture ||
      capture.reconfiguring ||
      !this.hasSubscribers(capture) ||
      sameHints(capture.desiredHints, capture.appliedHints)
    ) {
      this.releaseReplacementWaiters(capture);
      return;
    }
    capture.reconfigureTimer = this.timer.setTimeout(() => {
      capture.reconfigureTimer = null;
      const running = this.reconfigureCapture(deviceId, capture, { ...capture.desiredHints });
      capture.reconfiguring = running;
      void running.finally(() => {
        capture.reconfiguring = null;
        this.releaseReplacementWaiters(capture);
        this.scheduleReconfigure(deviceId, capture);
      });
    }, RECONFIGURE_DEBOUNCE_MS);
  }

  private resetForNewEncoder(capture: DeviceCapture): void {
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

  private retainSharedHints(capture: DeviceCapture, hints: CaptureHints): boolean {
    if (
      !capture.source ||
      !canRetainSharedCapture(capture.source, {
        device: capture.device,
        onData: () => {},
        bitrateBps: hints.bitrateKbps ? hints.bitrateKbps * 1000 : undefined,
        size: hints.size,
        quality: hints.quality,
        fps: hints.fps,
      })
    ) {
      return false;
    }
    // Preserve viewer/parser/liveness state when every binding hint is already satisfied.
    capture.appliedHints = hints;
    return true;
  }

  private async reconfigureCapture(
    deviceId: string,
    capture: DeviceCapture,
    hints: CaptureHints,
  ): Promise<void> {
    const outgoing = capture.source;
    if (!outgoing || this.captures.get(deviceId) !== capture) {
      return;
    }
    if (this.retainSharedHints(capture, hints)) {
      return;
    }
    // Fence the retiring source and its cache only at the swap. Existing viewers can consume its
    // output through the debounce; joiners held for the new hints cannot.
    capture.generation++;
    capture.source = null;
    this.resetForNewEncoder(capture);
    try {
      // Incompatible settings acquire a private source without disturbing other transports.
      await outgoing.stop();
      if (this.captures.get(deviceId) !== capture) {
        return;
      }
      const source = await this.createSource(capture, hints, capture.generation);
      if (this.captures.get(deviceId) !== capture) {
        await source.stop();
        return;
      }
      capture.source = source;
      if (tracksConsumers(source)) {
        source.setHasConsumers(this.hasSubscribers(capture));
      }
      await source.start();
      if (this.captures.get(deviceId) !== capture) {
        await source.stop();
        return;
      }
      capture.appliedHints = hints;
      logger.info(`[VideoStream] ${deviceId} shared capture quality changed`);
      const waiting = capture.waitingForKeyFrame.values().next().value;
      if (waiting) {
        this.requestKeyFrameForWaitingSubscriber(deviceId, waiting);
      }
    } catch (error) {
      logger.warn(`[VideoStream] failed to reconfigure capture for ${deviceId}: ${error}`);
      if (this.captures.get(deviceId) === capture) {
        // A failed stop may still own the encoder; teardown gets one final stop attempt.
        capture.source ??= outgoing;
        void this.stopCapture(deviceId);
      }
    }
  }

  private hasSubscribers(capture: DeviceCapture): boolean {
    return capture.pendingSubscribers.size > 0 || capture.subscribers.size > 0;
  }

  private promoteSubscriber(
    capture: DeviceCapture,
    socket: Socket,
    waitForKeyFrame: boolean,
  ): void {
    if (socket.destroyed) {
      capture.pendingSubscribers.delete(socket);
      return;
    }
    if (!capture.pendingSubscribers.delete(socket)) {
      return;
    }
    capture.subscribers.add(socket);
    if (waitForKeyFrame) {
      // A client that joins part way through a GOP must not consume inter frames before an IDR.
      // The immediate key-frame request that unfreezes it lives in the subscribe-ack path (which
      // runs for late joiners too); the backpressure-drain recovery is handled in the drain handler.
      capture.waitingForKeyFrame.add(socket);
    }
    if (this.reconfigurePending(capture)) {
      capture.waitingForReplacement.add(socket);
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
      this.writePacketToSubscriber(deviceId, capture, subscriber, packet, isConfig, isKeyFrame);
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
    this.writePacketToSubscriber(
      deviceId,
      capture,
      socket,
      encodePacket(
        encodePtsAndFlags(this.deps.nowUs(), { isKeyFrame: true }),
        capture.latestKeyFrameAu,
      ),
      false,
      true,
    );
    for (const au of capture.latestInterFrameAus) {
      this.writePacketToSubscriber(
        deviceId,
        capture,
        socket,
        encodePacket(encodePtsAndFlags(this.deps.nowUs(), {}), au),
        false,
        false,
      );
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
    packet: Buffer,
    isConfig: boolean,
    isKeyFrame: boolean,
  ): void {
    if (subscriber.destroyed) {
      this.detach(subscriber);
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
        const current = this.captures.get(deviceId);
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
        this.detach(subscriber);
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
  private requestKeyFrameForWaitingSubscriber(
    deviceId: string,
    subscriber: Socket,
    attemptsLeft: number = KEY_FRAME_RETRY_MAX_ATTEMPTS,
  ): void {
    const capture = this.captures.get(deviceId);
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

  private detach(socket: Socket): void {
    const stall = this.outboundStalls.get(socket);
    if (stall) {
      this.timer.clearTimeout(stall.timeout);
      socket.off("drain", stall.onDrain);
      this.outboundStalls.delete(socket);
    }
    const deviceId = this.socketDeviceIds.get(socket);
    this.socketDeviceIds.delete(socket);
    this.socketSessionUuids.delete(socket);
    this.socketSubscriptionKinds.delete(socket);
    this.acknowledgedSubscribers.delete(socket);
    if (!deviceId) {
      return;
    }

    const capture = this.captures.get(deviceId);
    if (!capture) {
      return;
    }
    capture.pendingSubscribers.delete(socket);
    capture.subscribers.delete(socket);
    capture.backpressuredSubscribers.delete(socket);
    capture.waitingForKeyFrame.delete(socket);
    capture.waitingForReplacement.delete(socket);
    if (!this.hasSubscribers(capture)) {
      if (capture.reconfigureTimer) {
        this.timer.clearTimeout(capture.reconfigureTimer);
        capture.reconfigureTimer = null;
      }
      if (tracksConsumers(capture.source)) {
        capture.source.setHasConsumers(false);
      }
      this.clearIdleTimer(capture);
      capture.idleTimer = this.timer.setTimeout(() => {
        capture.idleTimer = null;
        if (this.captures.get(deviceId) === capture && !this.hasSubscribers(capture)) {
          void this.stopCapture(deviceId);
        }
      }, CAPTURE_IDLE_GRACE_MS);
    }
  }

  private clearIdleTimer(capture: DeviceCapture): void {
    if (capture.idleTimer) {
      this.timer.clearTimeout(capture.idleTimer);
      capture.idleTimer = null;
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
      if (this.captures.get(deviceId) !== capture || !capture.source) {
        return;
      }
      if (!this.hasFreshSourceEvidence(deviceId, capture)) {
        // A reconnect must never inherit a capture we have already declared stale.
        // stopCapture removes it synchronously and serializes replacement behind source.stop().
        if (this.captures.get(deviceId) === capture) {
          void this.stopCapture(deviceId, true);
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
  private producerEvidenceIsStale(capture: DeviceCapture): boolean {
    const now = this.timer.now();
    return (
      (capture.lastSourceDataMs === null ||
        now - capture.lastSourceDataMs > SOURCE_EVIDENCE_MAX_AGE_MS) &&
      (capture.lastIdleMs === null || now - capture.lastIdleMs > SOURCE_EVIDENCE_MAX_AGE_MS)
    );
  }

  private clearHeartbeatTimer(capture: DeviceCapture): void {
    if (capture.heartbeatTimer) {
      this.timer.clearInterval(capture.heartbeatTimer);
      capture.heartbeatTimer = null;
    }
  }

  private stopCapture(deviceId: string, stale = false): Promise<void> {
    const pending = this.pendingStops.get(deviceId);
    if (pending) {
      return pending;
    }
    const capture = this.captures.get(deviceId);
    if (!capture) {
      return Promise.resolve();
    }
    this.captures.delete(deviceId);
    this.clearIdleTimer(capture);
    this.clearHeartbeatTimer(capture);
    if (capture.reconfigureTimer) {
      this.timer.clearTimeout(capture.reconfigureTimer);
      capture.reconfigureTimer = null;
    }

    for (const subscriber of [...capture.pendingSubscribers, ...capture.subscribers]) {
      this.detach(subscriber);
      this.endSocketBounded(subscriber);
    }
    capture.pendingSubscribers.clear();
    capture.subscribers.clear();
    capture.backpressuredSubscribers.clear();
    capture.waitingForKeyFrame.clear();
    capture.waitingForReplacement.clear();

    const stopping = (async () => {
      try {
        try {
          if (stale && capture.source) {
            await stopStaleCapture(capture.source, this.producerEvidenceIsStale(capture));
          } else {
            await capture.source?.stop();
          }
        } catch (error) {
          // A teardown failure must be visible, but must not prevent a later attach from retrying.
          logger.warn(`[VideoStream] failed to stop capture for ${deviceId}: ${error}`);
        }
        try {
          await capture.startup;
        } catch (error) {
          // Attach reports startup failures; teardown only needs to wait for late source cleanup.
          logger.debug(`[VideoStream] startup settled during stop for ${deviceId}: ${error}`);
        }
        await capture.reconfiguring;
      } finally {
        this.pendingStops.delete(deviceId);
      }
    })();
    this.pendingStops.set(deviceId, stopping);
    return stopping;
  }
}

const socketServer = new SocketServerSingleton<VideoStreamSocketServer>();

export function getVideoStreamSocketPath(): string {
  return socketServer.instance?.getSocketPath?.() ?? getSocketPath(VIDEO_STREAM_SOCKET_CONFIG);
}

export function setVideoStreamSocketServerForTesting(server: VideoStreamSocketServer | null): void {
  socketServer.instance = server;
}

/** Legacy video requests discover either platform; explicit platform requests stay scoped. */
export async function resolveVideoStreamDevice(
  deviceManager: Pick<PlatformDeviceManager, "getBootedDevices">,
  deviceId?: string,
  platform: "android" | "ios" | "either" = "either",
  timer: Timer = defaultTimer,
  signal?: AbortSignal,
): Promise<BootedDevice> {
  return resolveStreamDevice(
    deviceManager,
    deviceId,
    platform,
    timer,
    signal,
    "video-stream-resolve",
  );
}

async function defaultResolveDevice(
  deviceId?: string,
  platform?: "android" | "ios",
): Promise<BootedDevice> {
  return resolveVideoStreamDevice(
    DeviceSessionManager.getInstance().getPlatformDeviceManager(),
    deviceId,
    platform,
  );
}

function defaultDependencies(): VideoStreamSocketServerDependencies {
  return {
    captureRegistry: getDefaultDeviceCaptureRegistry(),
    ownershipChanges: () => {
      const state = DaemonState.getInstance();
      return state.isInitialized() ? state.getSessionManager() : null;
    },
    deviceLifecycle: getDaemonStreamDeviceLifecycleEmitter,
    sessionReleases: SessionReleaseBroadcaster,
    observerReleases: ObserverReleaseBroadcaster,
    resolveDevice: defaultResolveDevice,
    createCaptureSource: async (options) => {
      // Resolved once per stream, off the frame path. A null jar means the Android source falls
      // back to `screenrecord`.
      const jarPath = await resolveVideoServerJar();
      return createH264CaptureSource(
        {
          device: options.device,
          onData: options.onData,
          onSourceFrame: options.onSourceFrame,
          onSourceIdle: options.onSourceIdle,
          onEncodedAccessUnit: options.onEncodedAccessUnit,
          onIdleAttestationSupport: options.onIdleAttestationSupport,
          onError: options.onError,
          onRotation: options.onRotation,
          onDroppedFrames: options.onDroppedFrames,
          bitrateBps: options.bitrateBps,
          size: options.size,
          quality: options.quality,
          fps: options.fps,
        },
        jarPath,
      );
    },
    nowUs: () => BigInt(Math.round(performance.now() * 1000)),
  };
}

export async function startVideoStreamSocketServer(): Promise<void> {
  await socketServer.start(() => new VideoStreamSocketServer(defaultDependencies()));
}

export async function stopVideoStreamSocketServer(): Promise<void> {
  await socketServer.stop();
}
