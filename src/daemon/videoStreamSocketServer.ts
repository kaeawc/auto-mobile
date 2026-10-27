import type { DeviceReadiness } from "./readiness/DeviceReadiness";
import type { Socket } from "node:net";
import {
  canRetainSharedCapture,
  createDeviceCaptureRegistry,
  stopStaleCapture,
} from "../features/webrtc/deviceCaptureRegistry";
import { H264AccessUnitAssembler, H264AnnexBParser } from "../features/webrtc/h264";
import type { BootedDevice } from "../models";
import { ActionableError } from "../models";
import { toActionableError } from "../models/ActionableError";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { daemonDeviceAdmissionGate, type DeviceAdmissionGate } from "../utils/deviceAdmissionGate";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { VIDEO_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import { BaseSocketServer, getSocketPath } from "./socketServer/index";
import {
  authorizeResolvedDevice,
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import {
  decideLifecycleEvent,
  decideOwnershipChange,
  subscriptionKindForIdentity,
  type StreamSubscriptionEndReason,
  type StreamSubscriptionIdentity,
  type StreamSubscriptionKind,
} from "./wire/streamSubscriptionPolicy";
import {
  HEARTBEAT_INTERVAL_MS,
  OUTBOUND_STALL_TIMEOUT_MS,
  VideoStreamCapturePipeline,
} from "./videoStream/VideoStreamCapturePipeline";
import type { CaptureHints, DeviceCapture } from "./videoStream/captureTypes";
import { encodeStreamHeader, encodeSubscriptionNotice } from "./videoStreamFraming";
import { defaultDependencies, socketServer } from "./videoStreamSocketDefaults";
import {
  CAPTURE_IDLE_GRACE_MS,
  RECONFIGURE_DEBOUNCE_MS,
  VIDEO_STREAM_PURPOSE,
  VIDEO_STREAM_SOCKET_CLOSE_TIMEOUT_MS,
  sameHints,
  subscribeFailureResponse,
  subscriberMaySetCaptureHints,
  tracksConsumers,
  validateCaptureHints,
  type VideoStreamSocketServerDependencies,
} from "./videoStreamSocketSupport";
import type {
  VideoStreamSocketRequest,
  VideoStreamSocketResponse,
} from "./wire/videoStreamSocketTypes";

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
  private readonly pipeline: VideoStreamCapturePipeline;

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
    this.pipeline = new VideoStreamCapturePipeline(
      {
        getCapture: (deviceId) => this.captures.get(deviceId),
        detach: (socket) => this.detach(socket),
        stopCapture: (deviceId, stale) => this.stopCapture(deviceId, stale),
      },
      deps,
      deps.captureRegistry ?? createDeviceCaptureRegistry(),
      timer,
      this.outboundStalls,
    );
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
    await this.stopCapturesForClose();
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

  /**
   * Stop every capture, bounded: a source whose stop() never settles (encoder teardown waiting on
   * adb forward cleanup for a dead device) must not hold the rest of close(), or the daemon
   * shutdown stages behind it, past the process limit (#11601). The abandoned stop keeps running.
   */
  private async stopCapturesForClose(): Promise<void> {
    const timedOut = Symbol("video stream capture stop timeout");
    try {
      await raceWithDeadline(
        async () => {
          await Promise.all([...this.captures.keys()].map((id) => this.stopCapture(id)));
          await Promise.all(this.pendingStops.values());
        },
        {
          timer: this.timer,
          timeoutMs: VIDEO_STREAM_SOCKET_CLOSE_TIMEOUT_MS,
          label: "Video stream socket server shutdown",
          timeoutError: () => timedOut,
        },
      );
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      logger.warn(
        `[VideoStream] shutdown abandoned the capture stop for ${[...this.pendingStops.keys()].join(", ") || "no device"} ` +
          `after ${VIDEO_STREAM_SOCKET_CLOSE_TIMEOUT_MS}ms; continuing socket teardown`,
      );
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
        const source = await this.pipeline.createSource(
          capture,
          capture.appliedHints,
          capture.generation,
        );
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
        this.pipeline.clearHeartbeatTimer(capture);
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

  private primeAcknowledgedSubscriber(capture: DeviceCapture, socket: Socket): void {
    if (!this.reconfigurePending(capture)) {
      capture.waitingForReplacement.delete(socket);
      this.pipeline.primeSubscriber(capture, socket);
    }
    // A source may have emitted before acknowledgement. Ask for a post-ack IDR when the
    // subscriber is allowed to consume this encoder; throttled requests use the retry path.
    this.pipeline.requestKeyFrameForWaitingSubscriber(capture.device.deviceId, socket);
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
      this.pipeline.primeSubscriber(capture, subscriber);
      this.pipeline.requestKeyFrameForWaitingSubscriber(capture.device.deviceId, subscriber);
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
    this.pipeline.resetForNewEncoder(capture);
    try {
      // Incompatible settings acquire a private source without disturbing other transports.
      await outgoing.stop();
      if (this.captures.get(deviceId) !== capture) {
        return;
      }
      const source = await this.pipeline.createSource(capture, hints, capture.generation);
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
        this.pipeline.requestKeyFrameForWaitingSubscriber(deviceId, waiting);
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

  private detach(socket: Socket): void {
    this.pipeline.clearSubscriberStall(socket);
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
    this.pipeline.clearHeartbeatTimer(capture);
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
            await stopStaleCapture(capture.source, this.pipeline.producerEvidenceIsStale(capture));
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

export async function startVideoStreamSocketServer(
  readiness?: Pick<DeviceReadiness, "getPlatformDeviceManager">,
): Promise<void> {
  await socketServer.start(
    () => new VideoStreamSocketServer(defaultDependencies(readiness?.getPlatformDeviceManager())),
  );
}

export async function stopVideoStreamSocketServer(): Promise<void> {
  await socketServer.stop();
}

export {
  getVideoStreamSocketPath,
  resolveVideoStreamDevice,
  setVideoStreamSocketServerForTesting,
  validateCaptureHints,
  type DeviceOwnershipChanges,
  type VideoStreamSocketServerDependencies,
} from "./videoStreamSocketDefaults";
