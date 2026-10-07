import { SocketServerSingleton } from "./socketServerSingleton";
import {
  assertMayControl,
  subscriptionKindForIdentity,
  ViewerReadOnlyError,
  type StreamSubscriptionIdentity,
  type StreamSubscriptionLifecycleEndReason,
  type StreamSubscriptionKind,
} from "./streamSubscriptionPolicy";
import {
  getDaemonStreamDeviceLifecycleEmitter,
  type StreamDeviceLifecycleEvents,
} from "./streamDeviceLifecycleEvents";
import { SessionReleaseBroadcaster } from "../server/sessionReleaseBroadcast";
import { WebRtcSubscriptionEndedError } from "../server/WebRtcSubscriptionEndedError";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { RequestResponseSocketServer, getSocketPath } from "./socketServer/index";
import { WEBRTC_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import { ActionableError, type BootedDevice } from "../models";
import { MultiPlatformDeviceManager } from "../devices/deviceUtils";
import type {
  getWebRtcStreamDescriptor,
  getWebRtcSubscriptionKind,
  getWebRtcStreamDeviceIds,
  endWebRtcStreamsForDevice,
  listWebRtcStreams,
  startWebRtcStream,
  stopWebRtcStream,
  stopWebRtcStreamAsOwner,
  releaseWebRtcStreamOwnLeases,
  getWebRtcStreamControlContext,
  reconcileWebRtcStreamsForDeviceOwnership,
  stopAllWebRtcStreams,
  waitForWebRtcStreamReadiness,
} from "../server/webrtcStreamManager";
import type {
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse,
} from "./webrtcStreamSocketTypes";
import type { WebRtcStreamingOverrides } from "../features/webrtc";
import { assertWhipOverrideAllowed } from "../features/webrtc/webrtcStreamingConfig";
import {
  authorizeResolvedDevice,
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import { daemonDeviceAdmissionGate, type DeviceAdmissionGate } from "../utils/deviceAdmissionGate";
import { resolveStreamDevice } from "./streamDeviceResolver";
import { DaemonState } from "./daemonState";
import type { DeviceOwnershipChanges } from "./videoStreamSocketServer";
import { errorMessage } from "../utils/describeUnknownError";
import { raceWithDeadline } from "../utils/raceWithDeadline";

/** Injectable dependencies so the server can be tested without a device pool. */
export interface WebRtcStreamSocketServerDependencies {
  resolveDevice: (deviceId?: string, platform?: "android" | "ios") => Promise<BootedDevice>;
  startStream: typeof startWebRtcStream;
  stopStream: typeof stopWebRtcStream;
  stopStreamAsOwner?: typeof stopWebRtcStreamAsOwner;
  releaseOwnLeases?: typeof releaseWebRtcStreamOwnLeases;
  getControlContext?: typeof getWebRtcStreamControlContext;
  listStreams: typeof listWebRtcStreams;
  getStream: typeof getWebRtcStreamDescriptor;
  awaitReadiness?: typeof waitForWebRtcStreamReadiness;
  ownershipChanges?: () => DeviceOwnershipChanges | null;
  reconcileOwnership?: typeof reconcileWebRtcStreamsForDeviceOwnership;
  stopAllStreams?: typeof stopAllWebRtcStreams;
  getSubscriptionKind?: typeof getWebRtcSubscriptionKind;
  liveDeviceIds?: typeof getWebRtcStreamDeviceIds;
  endStreamsForDevice?: typeof endWebRtcStreamsForDevice;
  deviceLifecycle?: () => StreamDeviceLifecycleEvents | null;
  sessionReleases?: { subscribe(callback: (sessionId: string) => void): () => void };
}

interface WebRtcRequestContext {
  deps: WebRtcStreamSocketServerDependencies;
  request: WebRtcStreamSocketRequest;
  sessionUuid?: string;
  kind: StreamSubscriptionKind;
}
interface WebRtcStopControlFacts {
  target: "own_lease" | "stream";
  stopIdentity?: StreamSubscriptionIdentity;
  addressedStreamId?: string;
}

function ownLeaseControlTarget(input: {
  request: WebRtcStreamSocketRequest;
  context?: ReturnType<typeof getWebRtcStreamControlContext>;
}): "own_lease" | "stream" {
  const { request, context } = input;
  if (!context?.holdsLease) {
    return "stream";
  }
  return request.action === "stop" || (request.leaseId !== undefined && context.parametersMatch)
    ? "own_lease"
    : "stream";
}

/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const WEBRTC_STREAM_PURPOSE = "to start a WebRTC stream";

/**
 * Lazily import the stream manager (which pulls in werift) only when a request
 * actually arrives, so the daemon does not load the heavy WebRTC stack at boot.
 */
function loadManager() {
  return import("../server/webrtcStreamManager");
}

function defaultOwnershipChanges(): DeviceOwnershipChanges | null {
  const state = DaemonState.getInstance();
  return state.isInitialized() ? state.getSessionManager() : null;
}

const WEBRTC_SOCKET_CLOSE_TIMEOUT_MS = 5_000;

export { resolveStreamDevice as resolveWebRtcStreamDevice } from "./streamDeviceResolver";

const defaultDeviceManager = new MultiPlatformDeviceManager();

async function defaultResolveDevice(
  deviceId?: string,
  platform: "android" | "ios" = "android",
): Promise<BootedDevice> {
  return resolveStreamDevice(defaultDeviceManager, deviceId, platform);
}

function resolveStartOverrides(request: WebRtcStreamSocketRequest): WebRtcStreamingOverrides {
  const overrides: WebRtcStreamingOverrides = {};
  if (request.whipEndpoint) {
    overrides.whipEndpoint = request.whipEndpoint;
  }
  if (request.whipToken) {
    overrides.bearerToken = request.whipToken;
  }
  if (request.iceServers !== undefined) {
    overrides.iceServers = request.iceServers;
  }
  if (request.bitrateKbps !== undefined) {
    overrides.bitrateKbps = request.bitrateKbps;
  }
  if (request.size) {
    overrides.size = request.size;
  }
  if (request.iosSimulatorFps !== undefined) {
    overrides.iosSimulatorFps = request.iosSimulatorFps;
  }
  if (request.androidFps !== undefined) {
    overrides.androidFps = request.androidFps;
  }
  if (request.audio !== undefined) {
    overrides.audioEnabled = request.audio;
  }
  if (request.trickleIce !== undefined) {
    overrides.trickleIce = request.trickleIce;
  }
  return overrides;
}

/**
 * Unix-socket control plane for WebRTC screen streaming. A CI worker (or IDE)
 * connects to `~/.auto-mobile/webrtc-stream.sock` and sends newline-delimited
 * JSON requests to start, stop, or inspect live WHIP streams. This keeps stream
 * control in the long-lived daemon rather than the per-call MCP surface.
 *
 * The stream manager (and its werift dependency) is imported lazily on the first
 * request so the daemon does not load the WebRTC stack at boot.
 */
export class WebRtcStreamSocketServer extends RequestResponseSocketServer<
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse
> {
  private readonly injectedDeps?: WebRtcStreamSocketServerDependencies;
  private resolvedDeps: WebRtcStreamSocketServerDependencies | null = null;
  private readonly authenticator: StreamSocketAuthenticator;
  private readonly admissionGate: DeviceAdmissionGate;
  private removeOwnershipListener: (() => void) | null = null;
  private readonly removeListeners: Array<() => void> = [];
  private readonly viewerControlRejections = new Set<string>();
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(
    socketPath: string = getSocketPath(WEBRTC_STREAM_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    deps?: WebRtcStreamSocketServerDependencies,
    authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "webrtcStream",
    ),
    admissionGate: DeviceAdmissionGate = daemonDeviceAdmissionGate,
  ) {
    super(socketPath, timer, "WebRtcStream");
    this.injectedDeps = deps;
    this.authenticator = authenticator;
    this.admissionGate = admissionGate;
  }

  protected bypassesRequestChain(request: WebRtcStreamSocketRequest): boolean {
    return request.action === "stop";
  }

  protected override onServerStarted(): void {
    this.viewerControlRejections.clear();
    this.closed = false;
    this.closing = null;
    this.unsubscribeListeners();
    const ownershipChanges = this.injectedDeps
      ? this.injectedDeps.ownershipChanges
      : defaultOwnershipChanges;
    this.removeOwnershipListener =
      ownershipChanges?.()?.onDeviceOwnershipChange((deviceId) => {
        this.onOwnershipChanged(deviceId);
      }) ?? null;
    const sessionReleases = this.injectedDeps
      ? this.injectedDeps.sessionReleases
      : SessionReleaseBroadcaster;
    const removeRelease = sessionReleases?.subscribe(() => {
      for (const deviceId of this.resolvedDeps?.liveDeviceIds?.() ?? []) {
        this.onOwnershipChanged(deviceId);
      }
    });
    if (removeRelease) {
      this.removeListeners.push(removeRelease);
    }
    this.registerLifecycleListeners();
  }

  private registerLifecycleListeners(): void {
    const lifecycle = (
      this.injectedDeps ? this.injectedDeps.deviceLifecycle : getDaemonStreamDeviceLifecycleEmitter
    )?.();
    const removeDevice = lifecycle?.onDeviceRemoved((deviceId) =>
      this.endDeviceStreams({ deviceId, reason: "device_removed" }),
    );
    const removeIdentity = lifecycle?.onDeviceIdentityChanged((deviceId) =>
      this.checkDeviceActionable(deviceId),
    );
    for (const remove of [removeDevice, removeIdentity]) {
      if (remove) {
        this.removeListeners.push(remove);
      }
    }
  }

  private unsubscribeListeners(): void {
    this.removeOwnershipListener?.();
    this.removeOwnershipListener = null;
    for (const remove of this.removeListeners.splice(0)) {
      remove();
    }
  }

  private onOwnershipChanged(deviceId: string): void {
    void this.reconcileOwnership(deviceId).catch((error) => {
      logger.warn(`[WebRtcStream] ownership cleanup failed: ${errorMessage(error)}`, error);
    });
  }

  private endDeviceStreams(options: {
    deviceId: string;
    reason: StreamSubscriptionLifecycleEndReason;
  }): void {
    if (this.closed) {
      return;
    }
    void this.resolvedDeps?.endStreamsForDevice?.(options).catch((error) => {
      logger.warn(`[WebRtcStream] lifecycle cleanup failed: ${errorMessage(error)}`, error);
    });
  }

  private checkDeviceActionable(deviceId: string): void {
    if (this.closed || !this.resolvedDeps?.liveDeviceIds?.().includes(deviceId)) {
      return;
    }
    try {
      this.admissionGate.assertDeviceActionable(deviceId, WEBRTC_STREAM_PURPOSE);
    } catch (error) {
      logger.warn(
        `[WebRtcStream] identity no longer actionable for ${deviceId}: ${errorMessage(error)}`,
      );
      this.endDeviceStreams({ deviceId, reason: "identity_quarantined" });
    }
  }

  private async reconcileOwnership(deviceId: string): Promise<void> {
    // Never load werift merely because an idle daemon changed device ownership.
    if (this.closed || !this.resolvedDeps?.reconcileOwnership) {
      return;
    }
    await this.resolvedDeps.reconcileOwnership(deviceId, (sessionUuid) =>
      this.resolveLiveIdentity({ sessionUuid, deviceId }),
    );
  }

  private resolveLiveIdentity(input: {
    sessionUuid: string;
    deviceId: string;
  }): StreamSubscriptionIdentity {
    try {
      if (this.authenticator.resolveSubscriptionIdentity) {
        return this.authenticator.resolveSubscriptionIdentity(input);
      }
      this.authenticator.authorize({ ...input, requireOwnership: true });
      return { authEnabled: true, sessionExists: true, ownsDevice: true };
    } catch (error) {
      // Fail closed without logging authentication errors that may contain session UUIDs.
      logger.warn(
        `[WebRtcStream] subscription identity check failed for deviceId=${input.deviceId}; ending session subscription`,
      );
      return { authEnabled: true, sessionExists: false, ownsDevice: false };
    }
  }

  override close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.closed = true;
    this.viewerControlRejections.clear();
    this.unsubscribeListeners();
    this.closing = raceWithDeadline(
      async () => {
        await Promise.all([this.resolvedDeps?.stopAllStreams?.("daemon_shutdown"), super.close()]);
      },
      {
        timer: this.timer,
        timeoutMs: WEBRTC_SOCKET_CLOSE_TIMEOUT_MS,
        label: "WebRTC socket server shutdown",
      },
    ).catch((error) => {
      logger.warn(`[WebRtcStream] shutdown cleanup failed: ${errorMessage(error)}`, error);
    });
    return this.closing;
  }

  /** Resolve dependencies, lazily loading the (werift-heavy) manager on first use. */
  private async getDeps(): Promise<WebRtcStreamSocketServerDependencies> {
    if (this.injectedDeps) {
      this.resolvedDeps = this.injectedDeps;
      return this.injectedDeps;
    }
    if (!this.resolvedDeps) {
      const manager = await loadManager();
      this.resolvedDeps = {
        resolveDevice: defaultResolveDevice,
        startStream: manager.startWebRtcStream,
        stopStream: manager.stopWebRtcStream,
        stopStreamAsOwner: manager.stopWebRtcStreamAsOwner,
        releaseOwnLeases: manager.releaseWebRtcStreamOwnLeases,
        getControlContext: manager.getWebRtcStreamControlContext,
        listStreams: manager.listWebRtcStreams,
        getStream: manager.getWebRtcStreamDescriptor,
        awaitReadiness: manager.waitForWebRtcStreamReadiness,
        reconcileOwnership: manager.reconcileWebRtcStreamsForDeviceOwnership,
        stopAllStreams: manager.stopAllWebRtcStreams,
        getSubscriptionKind: manager.getWebRtcSubscriptionKind,
        liveDeviceIds: manager.getWebRtcStreamDeviceIds,
        endStreamsForDevice: manager.endWebRtcStreamsForDevice,
      };
    }
    return this.resolvedDeps;
  }

  protected async handleRequest(
    request: WebRtcStreamSocketRequest,
  ): Promise<WebRtcStreamSocketResponse> {
    try {
      this.assertOpen();
      this.authorizeRequest(request);
      const sessionUuid =
        this.authenticator.resolveSessionIdentity?.(request.sessionUuid) ?? request.sessionUuid;
      const deps = await this.getDeps();
      this.assertOpen();
      if (request.action === "start") {
        return await this.handleStart(deps, request, sessionUuid);
      }
      const kind =
        deps.getSubscriptionKind?.({
          streamId: request.streamId,
          leaseId: request.leaseId,
          sessionUuid,
        }) ?? "owner";
      const control = this.requestControlFacts({ deps, request, sessionUuid, kind });
      assertMayControl(control.stopIdentity?.ownsDevice ? "owner" : kind, {
        transport: "webrtc",
        action: request.action,
        target: control.target,
      });
      return await this.dispatchRequest({ deps, request, sessionUuid, kind, ...control });
    } catch (error) {
      return this.subscriptionErrorResponse({ request, error });
    }
  }

  private authorizeRequest(request: WebRtcStreamSocketRequest): void {
    // Start admits live device sessions as viewers. Attached viewers authenticate and
    // use manager facts for lease/stream authority even after the device changes owner.
    const admission = request.action === "start" || !this.authenticator.resolveSubscriptionIdentity;
    this.authenticator.authorize({
      sessionUuid: request.sessionUuid,
      deviceId: admission ? request.deviceId : undefined,
      admitViewer: request.action === "start",
    });
  }

  private requestControlFacts(input: WebRtcRequestContext): WebRtcStopControlFacts {
    const { deps, request, sessionUuid, kind } = input;
    if (request.action !== "start" && request.action !== "stop") {
      return { target: "stream" };
    }
    const context = deps.getControlContext?.({
      streamId: request.streamId,
      leaseId: request.leaseId,
      sessionUuid,
      deviceId: request.action === "start" ? request.deviceId : undefined,
      overrides: resolveStartOverrides(request),
      compareParameters: request.action === "start" && kind === "viewer",
    });
    return {
      target: ownLeaseControlTarget({ request, context }),
      addressedStreamId: context?.streamId,
      stopIdentity: this.resolveStopIdentity({ request, deviceId: context?.deviceId }),
    };
  }

  private resolveStopIdentity(input: {
    request: WebRtcStreamSocketRequest;
    deviceId?: string;
  }): StreamSubscriptionIdentity | undefined {
    if (input.request.action !== "stop" || input.deviceId === undefined) {
      return undefined;
    }
    const identity = this.authenticator.resolveSubscriptionIdentity?.({
      sessionUuid: input.request.sessionUuid,
      deviceId: input.deviceId,
    });
    // Auth-off and legacy authenticators retain the original stop semantics.
    return identity?.authEnabled && identity.sessionExists ? identity : undefined;
  }

  private logViewerControlRejection(request: WebRtcStreamSocketRequest): void {
    const sessionUuid =
      this.authenticator.resolveSessionIdentity?.(request.sessionUuid) ?? request.sessionUuid;
    const key = JSON.stringify([sessionUuid, request.leaseId, request.action]);
    const message = `[WebRtcStream] rejected viewer control: action=${request.action}`;
    if (this.viewerControlRejections.has(key)) {
      logger.debug(message);
      return;
    }
    this.viewerControlRejections.add(key);
    if (this.viewerControlRejections.size > 256) {
      const oldest = this.viewerControlRejections.values().next().value;
      if (oldest !== undefined) {
        this.viewerControlRejections.delete(oldest);
      }
    }
    logger.warn(message);
  }

  private subscriptionErrorResponse({
    request,
    error,
  }: {
    request: WebRtcStreamSocketRequest;
    error: unknown;
  }): WebRtcStreamSocketResponse {
    if (error instanceof ViewerReadOnlyError) {
      this.logViewerControlRejection(request);
      return {
        ...this.createErrorResponse(request.id, error.message),
        errorCode: error.code,
        subscriptionKind: "viewer",
      };
    }
    if (error instanceof WebRtcSubscriptionEndedError) {
      logger.info(`[WebRtcStream] reporting ended subscription: reason=${error.reason}`);
      return {
        ...this.createErrorResponse(request.id, error.message),
        reason: error.reason,
        subscriptionKind: error.subscriptionKind,
      };
    }
    throw error;
  }

  private async dispatchRequest(
    input: WebRtcRequestContext & WebRtcStopControlFacts,
  ): Promise<WebRtcStreamSocketResponse> {
    const { deps, request, sessionUuid, kind } = input;
    switch (request.action) {
      case "start":
        return this.handleStart(deps, request, sessionUuid);
      case "stop":
        return this.handleStop(input);
      case "status":
        return this.handleStatus(deps, request, sessionUuid);
      case "list":
        return {
          id: request.id,
          success: true,
          type: "webrtc_stream_response",
          action: "list",
          streams: deps.listStreams(),
          subscriptionKind: request.leaseId ? kind : undefined,
        };
      case "await":
        return this.handleAwait(deps, request, sessionUuid);
      default:
        throw new ActionableError(`Unsupported webrtcStream action: ${request.action}`);
    }
  }

  private async handleStop(
    input: WebRtcRequestContext & WebRtcStopControlFacts,
  ): Promise<WebRtcStreamSocketResponse> {
    const { deps, request, sessionUuid, kind } = input;
    const options = {
      streamId: input.addressedStreamId ?? request.streamId,
      leaseId: request.leaseId,
      sessionUuid,
    };
    const stream =
      input.stopIdentity?.ownsDevice && deps.stopStreamAsOwner
        ? await deps.stopStreamAsOwner(options)
        : input.stopIdentity && deps.releaseOwnLeases
          ? await deps.releaseOwnLeases(options)
          : await deps.stopStream(request.streamId, request.leaseId, sessionUuid);
    return {
      id: request.id,
      success: true,
      type: "webrtc_stream_response",
      action: "stop",
      stream,
      subscriptionKind: kind,
    };
  }

  private assertRenewalMayControl(input: {
    deps: WebRtcStreamSocketServerDependencies;
    request: WebRtcStreamSocketRequest;
    device: BootedDevice;
    sessionUuid?: string;
    subscriptionKind: StreamSubscriptionKind;
    renewingLease: boolean;
  }): void {
    const { deps, request, device, sessionUuid, subscriptionKind, renewingLease } = input;
    if (subscriptionKind !== "viewer" || !renewingLease) {
      return;
    }
    const context = deps.getControlContext?.({
      deviceId: device.deviceId,
      leaseId: request.leaseId,
      sessionUuid,
      overrides: resolveStartOverrides(request),
      compareParameters: true,
    });
    assertMayControl(subscriptionKind, {
      transport: "webrtc",
      action: "start",
      target: ownLeaseControlTarget({ request, context }),
    });
  }

  private subscriberStartOverrides(
    request: WebRtcStreamSocketRequest,
    subscriptionKind: StreamSubscriptionKind,
    renewingLease: boolean,
  ): WebRtcStreamingOverrides | undefined {
    // Fresh viewers attach with defaults; their wire overrides never reach capture.
    if (subscriptionKind === "viewer" && !renewingLease) {
      return undefined;
    }
    const overrides = resolveStartOverrides(request);
    if (overrides.whipEndpoint) {
      assertWhipOverrideAllowed(overrides.whipEndpoint);
    }
    return overrides;
  }

  private async handleStart(
    deps: WebRtcStreamSocketServerDependencies,
    request: WebRtcStreamSocketRequest,
    sessionUuid?: string,
  ): Promise<WebRtcStreamSocketResponse> {
    // FUNNEL 2, before the capture starts. The quarantine preserves the owning
    // session, so the authorization above still passes on a serial whose AVD the
    // pool can no longer identify; the stream would publish whichever runtime now
    // answers ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    // Gated twice because an omitted `deviceId` names its target only after
    // resolution, and the named serial must be refused before discovery runs.
    if (request.deviceId !== undefined) {
      this.admissionGate.assertDeviceActionable(request.deviceId, WEBRTC_STREAM_PURPOSE);
    }
    const device = await deps.resolveDevice(request.deviceId, request.platform ?? "android");
    this.assertOpen();
    this.admissionGate.assertDeviceActionable(device.deviceId, WEBRTC_STREAM_PURPOSE);
    authorizeResolvedDevice(this.authenticator, {
      sessionUuid: request.sessionUuid,
      deviceId: device.deviceId,
      admitViewer: true,
    });
    const { subscriptionKind, ownsDevice, renewingLease } = this.startSubscription({
      deps,
      request,
      device,
      sessionUuid,
    });
    const overrides = this.subscriberStartOverrides(request, subscriptionKind, renewingLease);
    if (!ownsDevice) {
      this.assertRenewalMayControl({
        deps,
        request,
        device,
        sessionUuid,
        subscriptionKind,
        renewingLease,
      });
    }
    const stream = await deps.startStream({
      device,
      streamId: request.streamId,
      leaseId: request.leaseId,
      sessionUuid,
      subscriptionKind,
      ownsDevice,
      overrides,
    });
    await this.recheckStartAdmission({ deps, request, device, stream, sessionUuid });
    logger.info(`[WebRtcStream] started stream ${stream.streamId} for device ${device.deviceId}`);
    return {
      id: request.id,
      success: stream.failure === null || stream.failure === undefined,
      type: "webrtc_stream_response",
      action: "start",
      stream,
      subscriptionKind:
        deps.getSubscriptionKind?.({
          streamId: stream.streamId,
          leaseId: stream.lease?.id,
          sessionUuid,
          existingLeaseOnly: true,
        }) ?? subscriptionKind,
      failure: stream.failure ?? null,
      error: stream.failure?.message,
    };
  }

  private startSubscription(input: {
    deps: WebRtcStreamSocketServerDependencies;
    request: WebRtcStreamSocketRequest;
    device: BootedDevice;
    sessionUuid?: string;
  }): { subscriptionKind: StreamSubscriptionKind; ownsDevice: boolean; renewingLease: boolean } {
    const { deps, request, device, sessionUuid } = input;
    const existingKind = request.leaseId
      ? deps.getSubscriptionKind?.({
          streamId: request.streamId,
          leaseId: request.leaseId,
          sessionUuid,
          allowEndedLease: true,
          existingLeaseOnly: true,
        })
      : undefined;
    const identity = this.authenticator.resolveSubscriptionIdentity?.({
      sessionUuid: request.sessionUuid,
      deviceId: device.deviceId,
    });
    const ownsDevice = !!identity?.authEnabled && identity.sessionExists && identity.ownsDevice;
    if (existingKind !== undefined) {
      return { subscriptionKind: existingKind, ownsDevice, renewingLease: true };
    }
    return {
      subscriptionKind: identity ? subscriptionKindForIdentity(identity) : "owner",
      ownsDevice,
      renewingLease: false,
    };
  }

  private async recheckStartAdmission(input: {
    deps: WebRtcStreamSocketServerDependencies;
    request: WebRtcStreamSocketRequest;
    device: BootedDevice;
    stream: NonNullable<WebRtcStreamSocketResponse["stream"]>;
    sessionUuid?: string;
  }): Promise<void> {
    const { deps, request, device, stream, sessionUuid } = input;
    try {
      this.assertOpen();
      authorizeResolvedDevice(this.authenticator, {
        sessionUuid: request.sessionUuid,
        deviceId: device.deviceId,
        admitViewer: true,
      });
      // A fresh lease may have been minted as owner before startup yielded. Reconcile
      // before replying even if the ownership notification was missed during startup.
      if (stream.lease?.id !== request.leaseId && this.authenticator.resolveSubscriptionIdentity) {
        await this.reconcileOwnership(device.deviceId);
      }
    } catch (error) {
      const leaseId = stream.lease?.id;
      if (leaseId && leaseId !== request.leaseId) {
        await raceWithDeadline(() => deps.stopStream(stream.streamId, leaseId, sessionUuid), {
          timer: this.timer,
          timeoutMs: WEBRTC_SOCKET_CLOSE_TIMEOUT_MS,
          label: "WebRTC rejected start lease cleanup",
        }).catch((cleanupError) => {
          logger.warn(
            `[WebRtcStream] rejected start cleanup failed: ${errorMessage(cleanupError)}`,
            cleanupError,
          );
        });
      }
      throw error;
    }
  }

  private async handleAwait(
    deps: WebRtcStreamSocketServerDependencies,
    request: WebRtcStreamSocketRequest,
    sessionUuid?: string,
  ): Promise<WebRtcStreamSocketResponse> {
    if (!request.streamId) {
      throw new ActionableError("The WebRTC await action requires streamId.");
    }
    if (!deps.awaitReadiness) {
      throw new ActionableError("WebRTC readiness waiting is unavailable.");
    }
    const stream = await deps.awaitReadiness(
      request.streamId,
      request.readiness ?? "publishing",
      request.timeoutMs,
      request.leaseId,
      sessionUuid,
    );
    return {
      id: request.id,
      success: stream.failure === null || stream.failure === undefined,
      type: "webrtc_stream_response",
      action: "await",
      stream,
      subscriptionKind:
        deps.getSubscriptionKind?.({
          streamId: stream.streamId,
          leaseId: stream.lease?.id,
          sessionUuid,
        }) ?? "owner",
      failure: stream.failure ?? null,
      error: stream.failure?.message,
    };
  }

  private handleStatus(
    deps: WebRtcStreamSocketServerDependencies,
    request: WebRtcStreamSocketRequest,
    sessionUuid?: string,
  ): WebRtcStreamSocketResponse {
    if (request.streamId) {
      const stream = deps.getStream(request.streamId, request.leaseId, sessionUuid);
      if (!stream) {
        throw new ActionableError(`No active WebRTC stream with id ${request.streamId}.`);
      }
      return {
        id: request.id,
        success: stream.failure === null || stream.failure === undefined,
        type: "webrtc_stream_response",
        action: "status",
        stream,
        subscriptionKind:
          deps.getSubscriptionKind?.({
            streamId: stream.streamId,
            leaseId: stream.lease?.id,
            sessionUuid,
          }) ?? "owner",
        failure: stream.failure ?? null,
        error: stream.failure?.message,
      };
    }
    return {
      id: request.id,
      success: true,
      type: "webrtc_stream_response",
      action: "list",
      streams: deps.listStreams(),
      subscriptionKind: request.leaseId
        ? (deps.getSubscriptionKind?.({ leaseId: request.leaseId, sessionUuid }) ?? "owner")
        : undefined,
    };
  }

  protected createErrorResponse(id: string | undefined, error: string): WebRtcStreamSocketResponse {
    return { id, success: false, type: "webrtc_stream_response", error };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ActionableError("WebRTC stream socket server is closed.");
    }
  }
}

const socketServer = new SocketServerSingleton<WebRtcStreamSocketServer>();

export function getWebRtcStreamSocketPath(): string {
  return socketServer.instance?.getSocketPath() ?? getSocketPath(WEBRTC_STREAM_SOCKET_CONFIG);
}

export async function startWebRtcStreamSocketServer(): Promise<void> {
  await socketServer.start(() => new WebRtcStreamSocketServer());
}

export async function stopWebRtcStreamSocketServer(): Promise<void> {
  await socketServer.stop();
}
