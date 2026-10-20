import { BuildContextStream } from "./deviceDataStream/BuildContextStream";
import {
  StreamCadence,
  DEFAULT_HIERARCHY_INTERVAL_MS,
  type DeviceDataFilter,
} from "./deviceDataStream/StreamCadence";
import { StorageSubscriptions } from "./deviceDataStream/StorageSubscriptions";
import { StreamSocketIdentities } from "./deviceDataStream/StreamSocketIdentities";
import {
  StreamRequests,
  DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS,
} from "./deviceDataStream/StreamRequests";
import { SocketServerSingleton } from "./socketServerSingleton";
import { errorMessage } from "../utils/describeUnknownError";
import { Socket } from "node:net";
import { logger } from "../utils/logger";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import {
  PushSubscriptionSocketServer,
  getSocketPath,
  SubscriptionResponse,
} from "./socketServer/index";
import type { ViewHierarchyResult } from "../models";
import type { StorageChangedEvent } from "../features/storage/storageTypes";
import {
  type DeviceSessionResolver,
  nullDeviceSessionResolver,
  deviceSessionErrorFields,
} from "./deviceSessionResolver";
import { SuspendedDeviceRoutingLog } from "./SuspendedDeviceRoutingLog";
import type { DeviceSessionRecord, DeviceSessionEndOptions } from "./deviceSessionRegistry";
import { DEVICE_DATA_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import { ObserverReleaseBroadcaster, type ObserverReleaseSource } from "./observerReleaseBroadcast";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
import {
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
  streamAuthRefusalFields,
} from "./streamSocketAuth";
import type { ScreenshotMetadata } from "../features/observe/ScreenshotMetadata";
import { annotateHierarchyDiff } from "./hierarchyStreamDiff";
import { readScreenScaleMetadata } from "../models/ScreenScaleMetadata";
import { COORDINATE_SPACE_PX, convertHierarchyToCanonicalPixels } from "./canonicalPixels";

import type {
  NavigationGraphStreamData,
  PerformanceStreamData,
  DeviceBuildKey,
  InitialFrameSubscriber,
  OnSubscriberConnectedCallback,
  OnScreenshotCadenceChangedCallback,
  OnHierarchyCadenceChangedCallback,
  OnObservationRequestedCallback,
  OnNavigationGraphRequestedCallback,
  OnStorageSubscriptionRequestedCallback,
  DeviceDataStreamMessage,
  PushScreenshotOptions,
  DeviceDataPush,
} from "./deviceDataStream/streamContracts";
export type {
  NavigationGraphStreamData,
  PerformanceStreamData,
  DeviceBuildKey,
  InitialFrameSubscriber,
  OnSubscriberConnectedCallback,
  OnScreenshotCadenceChangedCallback,
  OnHierarchyCadenceChangedCallback,
  RequestedObservation,
  OnObservationRequestedCallback,
  OnNavigationGraphRequestedCallback,
  OnStorageSubscriptionRequestedCallback,
} from "./deviceDataStream/streamContracts";
import { createScreenshotUpdate } from "./deviceDataStream/screenshotUpdate";

export { DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS };

/**
 * Socket server that streams device data updates (hierarchy, screenshot, storage) to connected IDE plugins.
 *
 * Unlike other socket servers which are request-response, this one maintains persistent
 * connections and pushes updates when they arrive from devices.
 *
 * Protocol:
 * - Client sends: {"id": "1", "command": "subscribe", "deviceId": "emulator-5554"}
 * - Server responds: {"id": "1", "type": "subscription_response", "success": true, "subscriptionId": "devicedatastream-1"}
 * - Server pushes: {"type": "hierarchy_update", "subscriptionId": "devicedatastream-1", "deviceId": "emulator-5554", "timestamp": 123, "data": {...}}
 * - Server pushes: {"type": "screenshot_update", "subscriptionId": "devicedatastream-1", "deviceId": "emulator-5554", "timestamp": 123, "screenshotBase64": "..."}
 * - Server pushes: {"type": "storage_update", "subscriptionId": "devicedatastream-1", "deviceId": "emulator-5554", "timestamp": 123, "storageEvent": {...}}
 * - Server pushes: {"type": "error", "subscriptionId": "devicedatastream-1", "deviceId": "emulator-5554", "timestamp": 123, "error": "device connection lost"}
 */
export class DeviceDataStreamSocketServer extends PushSubscriptionSocketServer<
  DeviceDataFilter,
  DeviceDataPush
> {
  /** Most recent device-authored identity received for each device. Kept even when no IDE is
   * subscribed: daemon-side input validation must not depend on an inspector being open. */
  private readonly currentFrameContexts = new Map<string, string>();
  /** Advances for accepted hierarchies and full boundaries, including contextless frames. */
  private readonly frameContextGenerations = new Map<string, number>();
  // Live pushes and device/session invalidation share this one initial-frame generation.
  protected readonly liveFrameGenerations = new Map<string, number>();
  private nextFrameGeneration = 0;
  // A full boundary can fence capture-only/removed serials without retaining map entries.
  private untrackedLiveFrameGeneration = 0;

  getLiveFrameGeneration(deviceId: string): number {
    return this.liveFrameGenerations.get(deviceId) ?? this.untrackedLiveFrameGeneration;
  }

  private recordLiveFramePush(deviceId: string): void {
    this.liveFrameGenerations.set(deviceId, ++this.nextFrameGeneration);
  }

  /** Fence initial captures/cache while preserving the unchanged screen's input and diff state. */
  invalidateInitialDeviceFrames(deviceId: string): void {
    this.recordLiveFramePush(deviceId);
  }

  /** Full boundary: neither initial nor explicit captures may restore pre-boundary input state. */
  invalidateDeviceFrames(deviceId: string): void {
    this.recordLiveFramePush(deviceId);
    this.recordFrameContext(deviceId);
    this.previousHierarchyByDevice.delete(deviceId);
  }

  /** Full removal followed by pruning; never reuse a removed serial's capture generation. */
  removeDeviceFrames(deviceId: string): void {
    this.invalidateDeviceFrames(deviceId);
    this.untrackedLiveFrameGeneration = ++this.nextFrameGeneration;
    this.liveFrameGenerations.delete(deviceId);
    this.frameContextGenerations.delete(deviceId);
  }

  getDeviceSessionUuid(deviceId: string): string | null {
    return this.deviceSessionResolver.resolveUuid(deviceId);
  }

  getCurrentFrameContext(deviceId: string): string | undefined {
    return this.currentFrameContexts.get(deviceId);
  }

  getCurrentFrameContextGeneration(deviceId: string): number {
    return this.frameContextGenerations.get(deviceId) ?? this.untrackedLiveFrameGeneration;
  }

  protected override deviceSessionResolver: DeviceSessionResolver = nullDeviceSessionResolver;
  private readonly suspendedRoutingLog = new SuspendedDeviceRoutingLog();
  private readonly initialFrameWaiters = new Map<string, AbortController>();
  private onSubscriberConnected: OnSubscriberConnectedCallback | null = null;
  private removeObserverReleaseListener: (() => void) | null = null;
  private removeSessionReleaseListener: (() => void) | null = null;

  // Previous hierarchy per device, used to compute the per-frame diff annotation
  // pushed on hierarchy_update. Cleared on device connection loss so a reconnect
  // starts from a clean baseline instead of diffing against a stale pre-drop tree.
  private previousHierarchyByDevice = new Map<string, ViewHierarchyResult>();

  // Source of capture ids (issue #3348). Process-wide and NEVER reset, so an id cannot be reused
  // after a reconnect and collide with a pre-drop hierarchy a client still holds. The current id
  // per device is deliberately NOT tracked here: callers bind it when they initiate a screenshot
  // request and hand it back on push, which is the only way to survive same-resolution navigation.
  private nextCaptureSequence = 1;

  private readonly storageSubscriptions: StorageSubscriptions;
  private readonly socketIdentities: StreamSocketIdentities;
  private readonly streamRequests: StreamRequests;
  private readonly cadence: StreamCadence;
  private readonly buildContexts: BuildContextStream;

  constructor(
    socketPath: string = getSocketPath(DEVICE_DATA_STREAM_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    private readonly authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "observationStream",
      { allowObserverSessions: true },
    ),
    private readonly observerReleases: ObserverReleaseSource = ObserverReleaseBroadcaster,
    /** Device-session releases; same listener shape as observer releases (#11130). */
    private readonly sessionReleases: ObserverReleaseSource = SessionReleaseBroadcaster,
  ) {
    super(socketPath, timer, "DeviceDataStream");
    this.buildContexts = new BuildContextStream({
      timer,
      resolveUuid: (deviceId) => this.deviceSessionResolver.resolveUuid(deviceId),
      pushForDevice: (deviceId, message, target) => this.pushForDevice(deviceId, message, target),
    });
    this.socketIdentities = new StreamSocketIdentities({
      authenticator,
      sendJson: (socket, message) => this.sendJson(socket, message),
      onConnectionClose: (socket) => this.onConnectionClose(socket),
    });
    this.storageSubscriptions = new StorageSubscriptions({
      authenticator,
      resolveStorageTargetDeviceId: (request, subscribe) =>
        this.resolveStorageTargetDeviceId(request, subscribe),
      sendJson: (socket, message) => this.sendJson(socket, message),
      recordSocketIdentity: (socket, sessionUuid) =>
        this.socketIdentities.recordSocketIdentity(socket, sessionUuid),
      endStaleIdentitySockets: () => this.socketIdentities.endStaleIdentitySockets(),
    });
    this.cadence = new StreamCadence({
      getSubscribers: () => this.subscribers.values(),
      findFilter: (socket, subscriptionId) => this.findSubscriber(socket, subscriptionId)?.filter,
      getDeviceSessionResolver: () => this.deviceSessionResolver,
      isSocketIdentityStale: (socket) => this.socketIdentities.isSocketIdentityStale(socket),
      hasSubscriberForDevice: (deviceId) => this.hasSubscriberForDevice(deviceId),
      sendJson: (socket, message) => this.sendJson(socket, message),
    });
    this.streamRequests = new StreamRequests({
      timer,
      authenticator,
      getDeviceSessionResolver: () => this.deviceSessionResolver,
      parseDeviceSessionUuid: (value) => this.parseDeviceSessionUuid(value),
      sendJson: (socket, message) => this.sendJson(socket, message),
      captureFrameContextGenerations: () => ({
        generations: new Map(this.frameContextGenerations),
        untrackedGeneration: this.untrackedLiveFrameGeneration,
      }),
      getCurrentFrameContextGeneration: (deviceId) =>
        this.getCurrentFrameContextGeneration(deviceId),
      pushHierarchyUpdate: (deviceId, hierarchy, frameContext) =>
        this.pushHierarchyUpdate(deviceId, hierarchy, frameContext),
    });
  }

  protected override onServerStarted(): void {
    super.onServerStarted();
    this.removeObserverReleaseListener?.();
    this.removeObserverReleaseListener = this.observerReleases.subscribe((sessionId) => {
      this.revokeIdentity(sessionId);
    });
    // A released device session (heartbeat, idle, plan, explicit) is not an observer release, so
    // re-resolve every admitted identity the way the video relay does: a released key may be a
    // derived `${base}:${label}` or a base whose derived keys a socket was admitted under (#11130).
    this.removeSessionReleaseListener?.();
    this.removeSessionReleaseListener = this.sessionReleases.subscribe(() => {
      this.socketIdentities.endStaleIdentitySockets();
    });
  }
  /**
   * End every connection admitted with `sessionUuid` (an observer whose registration was released
   * or expired, #11076): its subscriptions and storage observers are dropped and the client gets a
   * terminal `SESSION_ENDED` frame. Returns how many connections ended.
   */
  revokeIdentity(sessionUuid: string): number {
    return this.socketIdentities.revokeIdentity(sessionUuid);
  }

  /** Wire the serial↔`deviceSessionUuid` resolver used to stamp frames and route on the epoch key. */
  setDeviceSessionResolver(resolver: DeviceSessionResolver): void {
    // Full: a resolver can route the serial to another connection/incarnation even if
    // its current answers agree. The floor also fences captures with no live pushes yet.
    this.untrackedLiveFrameGeneration = ++this.nextFrameGeneration;
    // Initial-only hierarchies install input/diff state without a live-generation entry.
    for (const deviceId of new Set([
      ...this.liveFrameGenerations.keys(),
      ...this.frameContextGenerations.keys(),
    ])) {
      this.invalidateDeviceFrames(deviceId);
    }
    this.deviceSessionResolver = resolver;
  }

  /**
   * Whether frames attributed to this serial must be dropped because the pool's
   * entry for it is quarantined — see
   * {@link DeviceSessionResolver.isRoutingSuspended}. Logged once per quarantine,
   * not once per frame.
   */
  private isDeviceRoutingSuspended(deviceId: string): boolean {
    return this.suspendedRoutingLog.shouldDropFrame(
      this.deviceSessionResolver,
      deviceId,
      "DeviceDataStream",
    );
  }

  /**
   * Stamp a device-attributed frame with the live `deviceSessionUuid` for its
   * serial and push it, routing on that uuid. A serial with no live epoch resolves
   * to `null`, reaching only all-device subscribers; a serial whose pooled identity
   * is quarantined reaches nobody, because the serial is the only attribution the
   * frame has and it is exactly what is in doubt (#6863 review).
   */
  private pushForDevice(
    deviceId: string,
    message: DeviceDataStreamMessage,
    target?: InitialFrameSubscriber,
  ): number {
    if (this.isDeviceRoutingSuspended(deviceId)) {
      return 0;
    }
    // Re-check before every device frame: a released session's socket must not receive the next
    // holder's frames even if no release event reached this server (#11130).
    this.socketIdentities.endStaleIdentitySockets();
    const subscriber = target ? this.subscribers.get(target.subscriptionId) : undefined;
    if (target && (target.signal.aborted || !subscriber || subscriber.socket.destroyed)) {
      return 0;
    }
    const deviceSessionUuid = this.deviceSessionResolver.resolveUuid(deviceId);
    if (message.type === "device_build_context" && !target) {
      this.buildContexts.cacheBuildContext(deviceId, deviceSessionUuid, message);
    }
    return this.pushToSubscribers({
      message: { ...message, deviceSessionUuid },
      targetDeviceSessionUuid: deviceSessionUuid,
      // A fresh initial capture advances shared state, so every entitled pane must see it.
      // Cached/joined replays remain targeted and never advance that state.
      targetFilter: target?.replay ? subscriber?.filter : undefined,
    });
  }

  /**
   * Set a callback to be invoked when a subscriber connects.
   * This is used to trigger device WebSocket connections for real-time updates.
   */
  setOnSubscriberConnected(callback: OnSubscriberConnectedCallback): void {
    this.onSubscriberConnected = callback;
  }
  /**
   * Set a callback to be invoked when subscription cadence may have changed.
   */
  setOnScreenshotCadenceChanged(callback: OnScreenshotCadenceChangedCallback): void {
    this.cadence.setOnScreenshotCadenceChanged(callback);
  }

  /**
   * Set a callback to be invoked when active hierarchy polling cadence may have changed.
   */
  setOnHierarchyCadenceChanged(callback: OnHierarchyCadenceChangedCallback): void {
    this.cadence.setOnHierarchyCadenceChanged(callback);
  }

  /**
   * Set a callback to handle on-demand observation requests.
   */
  setOnObservationRequested(
    callback: OnObservationRequestedCallback,
    timeoutMs: number = DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS,
  ): void {
    this.streamRequests.setOnObservationRequested(callback.bind(this), timeoutMs);
  }

  /**
   * Set a callback to handle on-demand navigation graph requests.
   */
  setOnNavigationGraphRequested(callback: OnNavigationGraphRequestedCallback): void {
    this.streamRequests.setOnNavigationGraphRequested(callback.bind(this));
  }

  /**
   * Set a callback to handle per-file storage (un)subscription requests, so the daemon can register
   * the device-side content observer that produces `storage_update` frames.
   */
  setOnStorageSubscriptionRequested(callback: OnStorageSubscriptionRequestedCallback): void {
    this.storageSubscriptions.setOnStorageSubscriptionRequested(callback.bind(this));
  }

  private recordFrameContext(deviceId: string, frameContext?: string): void {
    this.frameContextGenerations.set(deviceId, ++this.nextFrameGeneration);
    if (frameContext !== undefined) {
      this.currentFrameContexts.set(deviceId, frameContext);
    } else {
      // A hierarchy with no proven token invalidates the previous input context.
      this.currentFrameContexts.delete(deviceId);
    }
  }

  /**
   * Push a hierarchy update to all subscribers interested in this device.
   */
  pushHierarchyUpdate(
    deviceId: string,
    hierarchy: ViewHierarchyResult,
    frameContext?: string,
    target?: InitialFrameSubscriber,
  ): number | null {
    if (!this.acceptObservationFramePush(deviceId, target)) {
      return null;
    }
    if (!target?.replay) {
      this.recordFrameContext(deviceId, frameContext);
    }
    // Skip the diff clone+walk when nobody is listening (the layout inspector is
    // usually closed): the frame would reach zero subscribers anyway. Drop the
    // baseline too so a later re-subscribe diffs from a fresh frame, not a tree
    // captured while it was away.
    if (!this.hasSubscriberForDevice(deviceId)) {
      this.previousHierarchyByDevice.delete(deviceId);
      return null;
    }

    const { annotated, summary, scaleMetadata } = this.annotateInitialOrLiveHierarchy(
      deviceId,
      hierarchy,
      target,
    );

    // Assign this capture's shared identity and RETURN it, so the caller can bind it to the
    // screenshot requests it initiates while this hierarchy is current.
    const captureSequence = target?.captureSequence ?? this.nextCaptureSequence++;

    const message: DeviceDataStreamMessage = {
      type: "hierarchy_update",
      deviceId,
      // Device-origin when the hierarchy carries its own capture time, daemon-origin otherwise —
      // so this field mixes clocks and must NOT be compared against a daemon- or client-stamped
      // time. Pair on `captureSequence` instead; `timestamp` is for display only.
      timestamp: hierarchy.updatedAt ?? this.timer.now(),
      data: annotated,
      hierarchyDiff: summary,
      captureSequence,
      ...(scaleMetadata
        ? { coordinateSpace: COORDINATE_SPACE_PX, nativeScale: scaleMetadata.nativeScale }
        : {}),
      frameContext,
      rotation: hierarchy.rotation,
    };

    const sentCount = this.pushForDevice(deviceId, message, target);
    if (sentCount > 0) {
      logger.debug(
        `[DeviceDataStream] Pushed hierarchy_update to ${sentCount} subscribers (device: ${deviceId})`,
      );
    }
    return captureSequence;
  }

  /** Recheck initial-frame scope/provenance, or invalidate initial captures for a live push. */
  private acceptObservationFramePush(deviceId: string, target?: InitialFrameSubscriber): boolean {
    if (!target) {
      // Generation only: the live push itself installs input context and advances the
      // diff from the previous hierarchy; it must not erase that baseline first.
      this.recordLiveFramePush(deviceId);
      return true;
    }
    return (
      this.initialFrameTargetWantsDevice(target, deviceId) &&
      (target.liveFrameGeneration === undefined ||
        target.liveFrameGeneration === this.getLiveFrameGeneration(deviceId)) &&
      (target.deviceSessionUuid === undefined ||
        target.deviceSessionUuid === this.getDeviceSessionUuid(deviceId)) &&
      (target.frameContextGeneration === undefined ||
        target.frameContextGeneration === this.getCurrentFrameContextGeneration(deviceId))
    );
  }

  private annotateInitialOrLiveHierarchy(
    deviceId: string,
    hierarchy: ViewHierarchyResult,
    target?: InitialFrameSubscriber,
  ) {
    // Annotate the frame with its per-node diff versus the last frame for this
    // device (added/changed nodes carry a `diffState` attribute; a summary rides
    // the message). The input is cloned, so the annotated copy pushed to clients
    // never mutates the caller's hierarchy; the un-annotated original is retained
    // as the next baseline.
    const previous = target ? null : (this.previousHierarchyByDevice.get(deviceId) ?? null);
    const { hierarchy: annotated, summary } = annotateHierarchyDiff(previous, hierarchy);
    // Baseline the UN-annotated, UN-converted original so the next frame's diff is computed in the
    // same (point) space the runner reports — the diff must not see the canonical-pixel rewrite.
    if (!target?.replay) {
      this.previousHierarchyByDevice.set(deviceId, hierarchy);
    }

    // Convert to canonical pixels on the clone we own (never the caller's hierarchy or the baseline,
    // so MCP observe keeps serving point-space bounds). Only when the runner supplied complete scale
    // metadata; otherwise the frame stays point-space and is not stamped (legacy fallback).
    const scaleMetadata = readScreenScaleMetadata(hierarchy);
    if (scaleMetadata) {
      convertHierarchyToCanonicalPixels(annotated, scaleMetadata);
    }

    return { annotated, summary, scaleMetadata };
  }

  /**
   * Push a screenshot update to all subscribers interested in this device.
   */
  pushScreenshotUpdate(
    deviceId: string,
    screenshotBase64: string,
    screenWidth: number | undefined,
    screenHeight: number | undefined,
    metadata: ScreenshotMetadata = {},
    options: PushScreenshotOptions = {},
  ): boolean {
    if (!this.acceptObservationFramePush(deviceId, options.initialFrameSubscriber)) {
      return false;
    }
    const message = createScreenshotUpdate(
      { deviceId, screenshotBase64, screenWidth, screenHeight, metadata, options },
      this.timer,
    );
    const sentCount = this.pushForDevice(deviceId, message, options.initialFrameSubscriber);
    if (sentCount > 0) {
      logger.debug(
        `[DeviceDataStream] Pushed screenshot_update to ${sentCount} subscribers (device: ${deviceId})`,
      );
    }
    return sentCount > 0;
  }

  /**
   * Push a navigation graph update, targeting the device whose graph changed
   * (epic #5256, item 3 — closes #4837, which cross-contaminated panes because
   * this broadcast to every subscriber). The daemon resolves the graph's owning
   * serial from the app's build context; `deviceId` is `null` only when that
   * provenance is unknown, in which case the frame reaches all-device subscribers
   * (`null` filter) but never a specific device's pane.
   */
  pushNavigationGraphUpdate(
    navigationGraph: NavigationGraphStreamData,
    deviceId: string | null,
  ): void {
    if (deviceId !== null && this.isDeviceRoutingSuspended(deviceId)) {
      return;
    }
    const deviceSessionUuid = deviceId ? this.deviceSessionResolver.resolveUuid(deviceId) : null;
    const message: DeviceDataStreamMessage = {
      type: "navigation_update",
      deviceId: deviceId ?? undefined,
      deviceSessionUuid,
      timestamp: this.timer.now(),
      navigationGraph,
    };

    const sentCount = this.pushToSubscribers({
      message,
      targetDeviceSessionUuid: deviceSessionUuid,
    });
    if (sentCount > 0) {
      logger.debug(`[DeviceDataStream] Pushed navigation_update to ${sentCount} subscribers`);
    }
  }

  /**
   * Push a device-session lifecycle frame so consumers flush per-device state on a
   * real epoch boundary (epic #5256, item 3). Emitted from the registry's
   * connect/disconnect transitions; targets the session's own uuid so both a
   * device-scoped pane and an all-device hub observe the transition.
   */
  pushDeviceSessionStarted(record: DeviceSessionRecord): void {
    this.buildContexts.removeDevice(record.deviceId);
    // Full: registry epoch start/replacement binds a new connection/incarnation.
    this.invalidateDeviceFrames(record.deviceId);
    this.pushDeviceSessionLifecycle("device_session_started", record);
  }

  pushDeviceSessionEnded(record: DeviceSessionRecord, options?: DeviceSessionEndOptions): void {
    this.buildContexts.removeDevice(record.deviceId);
    // Full: epoch retirement/replacement ends trust in this connection/incarnation.
    this.invalidateDeviceFrames(record.deviceId);
    this.pushDeviceSessionLifecycle("device_session_ended", record, options);
  }

  private pushDeviceSessionLifecycle(
    type: "device_session_started" | "device_session_ended",
    record: DeviceSessionRecord,
    options?: DeviceSessionEndOptions,
  ): void {
    const message: DeviceDataStreamMessage = {
      type,
      deviceId: record.deviceId,
      deviceSessionUuid: record.deviceSessionUuid,
      ...options,
      platform: record.platform,
      timestamp: this.timer.now(),
    };
    const sentCount = this.pushToSubscribers({
      message,
      targetDeviceSessionUuid: record.deviceSessionUuid,
    });
    if (sentCount > 0) {
      logger.debug(
        `[DeviceDataStream] Pushed ${type} to ${sentCount} subscribers (device: ${record.deviceId}, session: ${record.deviceSessionUuid})`,
      );
    }
  }

  /**
   * Push a performance metrics update to all subscribers interested in this device.
   */
  pushPerformanceUpdate(deviceId: string, performanceData: PerformanceStreamData): void {
    const message: DeviceDataStreamMessage = {
      type: "performance_update",
      deviceId,
      timestamp: this.timer.now(),
      performanceData,
    };

    const sentCount = this.pushForDevice(deviceId, message);
    if (sentCount > 0) {
      logger.debug(
        `[DeviceDataStream] Pushed performance_update to ${sentCount} subscribers (device: ${deviceId})`,
      );
    }
  }

  /**
   * Push a storage change event to all subscribers interested in this device.
   */
  pushStorageUpdate(deviceId: string, event: StorageChangedEvent): void {
    const message: DeviceDataStreamMessage = {
      type: "storage_update",
      deviceId,
      timestamp: this.timer.now(),
      storageEvent: event,
    };

    const sentCount = this.pushForDevice(deviceId, message);
    if (sentCount > 0) {
      logger.debug(
        `[DeviceDataStream] Pushed storage_update to ${sentCount} subscribers (device: ${deviceId})`,
      );
    }
  }
  /**
   * Return true when at least one active subscriber would receive updates for this device.
   */
  hasSubscriberForDevice(deviceId: string): boolean {
    return this.cadence.hasSubscriberForDevice(deviceId);
  }

  /**
   * Return the fastest active screenshot cadence requested for this device,
   * or the default low-cost keepalive cadence when none is requested.
   */
  getScreenshotIntervalMsForDevice(deviceId: string): number {
    return this.cadence.getScreenshotIntervalMsForDevice(deviceId);
  }

  /**
   * Return the fastest active hierarchy cadence requested for this device,
   * or the default iOS hierarchy polling cadence when none is requested.
   */
  getHierarchyIntervalMsForDevice(
    deviceId: string,
    defaultIntervalMs: number = DEFAULT_HIERARCHY_INTERVAL_MS,
  ): number {
    return this.cadence.getHierarchyIntervalMsForDevice(deviceId, defaultIntervalMs);
  }

  /**
   * Notify subscribers that the underlying device control connection was lost.
   */
  onDeviceConnectionLost(deviceId: string): void {
    // Full: reconnect may see another screen/incarnation, so retire input and diff state.
    this.invalidateDeviceFrames(deviceId);
    // Nothing to reset for capture identity: ids are never reused (the source is monotonic for the
    // process), and clients drop their own bindings when the connection goes away.

    const message: DeviceDataStreamMessage = {
      type: "error",
      success: false,
      deviceId,
      timestamp: this.timer.now(),
      error: "device connection lost",
    };

    const sentCount = this.pushForDevice(deviceId, message);
    if (sentCount > 0) {
      logger.debug(
        `[DeviceDataStream] Pushed device connection lost error to ${sentCount} subscribers (device: ${deviceId})`,
      );
    }
  }

  /** @internal Dispatch one line through the normal parser with a fake Socket; no listener is needed. */
  public async dispatchLineForTesting(socket: Socket, line: string): Promise<void> {
    await this.processLine(socket, line);
  }

  /**
   * Override processLine to handle additional commands and the onSubscriberConnected callback.
   */
  protected async processLine(socket: Socket, line: string): Promise<void> {
    const request = this.parseJson<{
      id?: string;
      command: string;
      sessionUuid?: string;
      deviceId?: string;
      deviceSessionUuid?: string;
      appId?: string;
      screenshotIntervalMs?: unknown;
      hierarchyIntervalMs?: unknown;
      subscriptionId?: string;
      packageName?: string;
      fileName?: string;
    }>(line);

    if (!request) {
      const errorResponse: SubscriptionResponse = {
        type: "error",
        success: false,
        error: "Invalid JSON",
      };
      this.sendJson(socket, errorResponse);
      return;
    }

    // Handle request_observation command (not in base class)
    if (request.command === "request_observation") {
      await this.handleObservationRequest(socket, request);
      return;
    }

    // Handle request_navigation_graph command
    if (request.command === "request_navigation_graph") {
      await this.streamRequests.handleNavigationGraphRequest(socket, request);
      return;
    }

    // Handle per-file storage (un)subscription: register/release a device-side content observer so
    // external writes to a key/value store emit storage_update frames.
    if (request.command === "subscribe_storage" || request.command === "unsubscribe_storage") {
      await this.storageSubscriptions.handleStorageSubscriptionRequest(socket, request);
      return;
    }

    // Handle subscribe with onSubscriberConnected callback
    if (request.command === "subscribe") {
      await this.handleObservationSubscribe(socket, request, line);
      return;
    }

    if (request.command === "unsubscribe") {
      const filter = request.subscriptionId
        ? this.findSubscriber(socket, request.subscriptionId)?.filter
        : undefined;
      await super.processLine(socket, line);
      this.abortRemovedInitialFrameWaiters();
      if (filter) {
        this.cadence.notifyCadenceChangedForFilter(filter);
      }
      return;
    }

    // Update the requested cadence for an existing subscription in place, without a
    // resubscribe (which would leak a duplicate subscriber and re-trigger backfill). Lets a
    // subscriber raise the cadence while it is actively viewing the device and relax it when
    // backgrounded. Older daemons reply with a benign "unknown command" error.
    if (request.command === "update_cadence") {
      this.cadence.handleCadenceUpdate(socket, request);
      return;
    }

    // Delegate to base class for standard commands (subscribe, unsubscribe, pong)
    await super.processLine(socket, line);
  }

  private async handleObservationSubscribe(
    socket: Socket,
    request: { id?: string; sessionUuid?: string; deviceSessionUuid?: string },
    line: string,
  ): Promise<void> {
    let deviceSessionUuid: string | null;
    try {
      this.authenticator.authorize({ sessionUuid: request.sessionUuid });
      // JSON parsing does not validate fields at runtime. Do it before the
      // base server creates a subscription so malformed keys cannot quietly
      // become all-device subscriptions.
      deviceSessionUuid = this.parseDeviceSessionUuid(request.deviceSessionUuid);
    } catch (error) {
      logger.warn(`Observation subscribe rejected: ${errorMessage(error)}`, error);
      const errorResponse: SubscriptionResponse = {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...streamAuthRefusalFields(error),
        ...deviceSessionErrorFields(error),
      };
      this.sendJson(socket, errorResponse);
      return;
    }

    const subscribedDeviceId =
      deviceSessionUuid === null
        ? null
        : this.deviceSessionResolver.resolveDeviceId(deviceSessionUuid);
    if (deviceSessionUuid !== null && subscribedDeviceId === null) {
      const errorResponse: SubscriptionResponse = {
        id: request.id,
        type: "error",
        success: false,
        error: this.deviceSessionResolver.getSessionError(deviceSessionUuid).message,
        ...deviceSessionErrorFields(this.deviceSessionResolver.getSessionError(deviceSessionUuid)),
      };
      this.sendJson(socket, errorResponse);
      return;
    }

    // Let base class handle the subscription
    this.socketIdentities.recordSocketIdentity(socket, request.sessionUuid);
    await super.processLine(socket, line);

    // The wire now targets a deviceSessionUuid; the cadence/connect machinery is
    // serial-scoped, so resolve to the current serial. A missing UUID is an
    // intentional all-device subscription; an unresolvable UUID schedules no
    // device and must not be treated as that all-device case.
    if (deviceSessionUuid === null || subscribedDeviceId !== null) {
      this.cadence.notifyScreenshotCadenceChanged(subscribedDeviceId);
      this.cadence.notifyHierarchyCadenceChanged(subscribedDeviceId);
    }
  }

  protected onSubscribed(subscriptionId: string, filter: DeviceDataFilter, _socket: Socket): void {
    const controller = new AbortController();
    this.initialFrameWaiters.set(subscriptionId, controller);
    this.buildContexts.replayBuildContexts({
      subscriptionId,
      signal: controller.signal,
      replay: true,
    });
    try {
      // Base registration calls this synchronously, before processLine yields. Android client
      // creation must still precede immediately-following subscribe_storage commands.
      this.onSubscriberConnected?.(filter.deviceId, { subscriptionId, signal: controller.signal });
    } catch (error) {
      logger.warn(
        `[DeviceDataStream] Error in onSubscriberConnected callback: ${errorMessage(error)}`,
        error,
      );
    }
  }
  /** Lightweight provenance updates reuse the device-stamping path; unknown keys are omitted. */
  pushBuildContextUpdate(
    deviceId: string,
    packageId: string,
    buildKey: DeviceBuildKey | null,
  ): void {
    this.buildContexts.pushBuildContextUpdate(deviceId, packageId, buildKey);
  }

  private initialFrameTargetWantsDevice(target: InitialFrameSubscriber, deviceId: string): boolean {
    const subscriber = this.subscribers.get(target.subscriptionId);
    return (
      !target.signal.aborted &&
      !!subscriber &&
      !subscriber.socket.destroyed &&
      !this.isDeviceRoutingSuspended(deviceId) &&
      this.matchesFilter(subscriber.filter, {
        message: { type: "hierarchy_update", deviceId, timestamp: this.timer.now() },
        targetDeviceSessionUuid: this.deviceSessionResolver.resolveUuid(deviceId),
      })
    );
  }

  private abortRemovedInitialFrameWaiters(): void {
    for (const [id, controller] of this.initialFrameWaiters) {
      if (!this.subscribers.has(id) || this.subscribers.get(id)?.socket.destroyed) {
        controller.abort();
        this.initialFrameWaiters.delete(id);
      }
    }
  }

  protected onServerClosing(): void {
    this.removeObserverReleaseListener?.();
    this.removeObserverReleaseListener = null;
    this.removeSessionReleaseListener?.();
    this.removeSessionReleaseListener = null;
    this.socketIdentities.clear();
    super.onServerClosing();
    this.abortRemovedInitialFrameWaiters();
  }

  protected onConnectionClose(socket: Socket): void {
    this.socketIdentities.delete(socket);
    const filters = this.getSubscribersForSocket(socket).map((subscriber) => subscriber.filter);
    super.onConnectionClose(socket);
    this.abortRemovedInitialFrameWaiters();
    this.storageSubscriptions.releaseStorageSubscriptionsForSocket(socket, false);
    for (const filter of filters) {
      this.cadence.notifyCadenceChangedForFilter(filter);
    }
  }

  protected onConnectionError(socket: Socket, error: Error): void {
    this.socketIdentities.delete(socket);
    const filters = this.getSubscribersForSocket(socket).map((subscriber) => subscriber.filter);
    super.onConnectionError(socket, error);
    this.abortRemovedInitialFrameWaiters();
    this.storageSubscriptions.releaseStorageSubscriptionsForSocket(socket, true);
    for (const filter of filters) {
      this.cadence.notifyCadenceChangedForFilter(filter);
    }
  }

  protected checkKeepalive(): void {
    const filtersBySubscriptionId = new Map(
      [...this.subscribers].map(([subscriptionId, subscriber]) => [
        subscriptionId,
        subscriber.filter,
      ]),
    );
    super.checkKeepalive();
    this.abortRemovedInitialFrameWaiters();
    for (const [subscriptionId, filter] of filtersBySubscriptionId) {
      if (!this.subscribers.has(subscriptionId)) {
        this.cadence.notifyCadenceChangedForFilter(filter);
      }
    }
  }

  protected parseSubscriptionFilter(request: Record<string, unknown>): DeviceDataFilter {
    const deviceSessionUuid = this.parseDeviceSessionUuid(request.deviceSessionUuid);
    return {
      deviceSessionUuid,
      // Resolve the serial once, at subscribe time, for the serial-scoped cadence
      // machinery. Within an epoch the serial is stable, so a snapshot is safe.
      deviceId: deviceSessionUuid
        ? this.deviceSessionResolver.resolveDeviceId(deviceSessionUuid)
        : null,
      screenshotIntervalMs: this.cadence.parseScreenshotIntervalMs(request.screenshotIntervalMs),
      hierarchyIntervalMs: this.cadence.parseHierarchyIntervalMs(request.hierarchyIntervalMs),
    };
  }

  protected matchesFilter(filter: DeviceDataFilter, data: DeviceDataPush): boolean {
    if (data.targetFilter && data.targetFilter !== filter) {
      return false;
    }
    // Route on the stable epoch key. A `null` target reaches only all-device
    // (`null`-filter) subscribers — there is no cross-device broadcast, so a frame
    // for one device (or a retired epoch, which resolves to `null`) can never leak
    // into another device's subscription (epic #5256, AC2/AC4; closes #4837).
    return (
      filter.deviceSessionUuid === null ||
      (filter.deviceId !== null && filter.deviceSessionUuid === data.targetDeviceSessionUuid)
    );
  }

  protected createPushMessage(
    data: DeviceDataPush,
    subscriptionId: string,
  ): DeviceDataStreamMessage {
    return { ...data.message, subscriptionId };
  }
  /**
   * Re-register every active observer for [deviceId] after its Android CtrlProxy reconnects.
   * A retained zero-owner entry instead retries its failed teardown. Desktop socket ownership
   * deliberately remains intact across that runner-only reconnect.
   */
  async reapplyStorageSubscriptionsForDevice(deviceId: string): Promise<void> {
    await this.storageSubscriptions.reapplyStorageSubscriptionsForDevice(deviceId);
  }

  /**
   * The serial a storage (un)subscription targets, or null for an all-device
   * request. Throws the message the caller reports verbatim.
   *
   * A supplied-but-unresolvable session UUID must NOT fall through to a null
   * (all-device) target: daemon.ts treats null as every device, so a stale or
   * unknown UUID would otherwise register or release the content observer on every
   * Android device and still ack success. A missing UUID stays an intentional
   * device-scoped-by-serial request.
   *
   * FUNNEL 2 for that raw-serial form: the session-keyed form resolves through
   * `resolveDeviceId`, which already withholds a quarantined serial, while the raw
   * one skips that resolution entirely — and registering an observer on a serial
   * the pool can no longer tie to a runtime observes whichever AVD now answers
   * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review). Teardown is
   * exempt: refusing it would strand the observer this daemon registered, and
   * releasing it touches only bookkeeping the quarantine does not question.
   */
  private resolveStorageTargetDeviceId(
    request: { deviceId?: string; deviceSessionUuid?: string },
    subscribe: boolean,
  ): string | null {
    // JSON parsing does not validate fields at runtime; reject a malformed key
    // before it can quietly resolve to a null (all-device) target.
    const deviceSessionUuid = this.parseDeviceSessionUuid(request.deviceSessionUuid);
    const deviceId =
      deviceSessionUuid === null
        ? (request.deviceId ?? null)
        : this.deviceSessionResolver.resolveDeviceId(deviceSessionUuid);
    if (deviceSessionUuid !== null && deviceId === null) {
      throw this.deviceSessionResolver.getSessionError(deviceSessionUuid);
    }
    if (subscribe && deviceId !== null) {
      this.deviceSessionResolver.assertDeviceActionable(deviceId, "to watch stored values");
    }
    return deviceId;
  }

  private async handleObservationRequest(
    socket: Socket,
    request: { id?: string; deviceId?: string; deviceSessionUuid?: string; sessionUuid?: string },
  ): Promise<void> {
    await this.streamRequests.handleObservationRequest(socket, request, (deviceId) => {
      this.deviceSessionResolver.assertDeviceActionable(deviceId, "to observe");
    });
  }
}

// Singleton instance
const socketServer = new SocketServerSingleton<DeviceDataStreamSocketServer>();

/** @internal Install an unstarted fake-backed server for unit tests; no socket is opened. */
export function installDeviceDataStreamSocketServerForTesting(
  server: DeviceDataStreamSocketServer | null,
): void {
  socketServer.instance = server;
}

export function getDeviceDataStreamServer(): DeviceDataStreamSocketServer | null {
  return socketServer.instance;
}

export function getDeviceDataStreamSocketPath(): string {
  return socketServer.instance?.getSocketPath() ?? getSocketPath(DEVICE_DATA_STREAM_SOCKET_CONFIG);
}

export async function startDeviceDataStreamSocketServer(
  timer: Timer = defaultTimer,
): Promise<DeviceDataStreamSocketServer> {
  return await socketServer.start(
    () => new DeviceDataStreamSocketServer(getSocketPath(DEVICE_DATA_STREAM_SOCKET_CONFIG), timer),
  );
}

export async function stopDeviceDataStreamSocketServer(): Promise<void> {
  await socketServer.stop();
}
