import { SocketServerSingleton } from "./socketServerSingleton";
import { errorMessage } from "../utils/describeUnknownError";
import { Socket } from "node:net";
import { logger } from "../utils/logger";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import {
  PushSubscriptionSocketServer,
  getSocketPath,
  SubscriptionResponse,
} from "./socketServer/index";
import type { ObserveResult, Platform, ViewHierarchyResult } from "../models";
import type { StorageChangedEvent } from "../features/storage/storageTypes";
import {
  type DeviceSessionResolver,
  nullDeviceSessionResolver,
  SuspendedDeviceRoutingLog,
  deviceSessionErrorFields,
} from "./deviceSessionResolver";
import type {
  DeviceSessionRecord,
  DeviceSessionEndOptions,
  DeviceSessionRetireReason,
} from "./deviceSessionRegistry";
import { DEVICE_DATA_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import {
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import type { ScreenshotMetadata } from "../features/observe/ScreenshotMetadata";
import { annotateHierarchyDiff, type HierarchyDiffSummary } from "./hierarchyStreamDiff";
import { readImageHeaderDimensions } from "../utils/screenshot/imageHeaderDimensions";
import { readScreenScaleMetadata } from "../models/ScreenScaleMetadata";
import {
  COORDINATE_SPACE_PX,
  convertHierarchyToCanonicalPixels,
  type CoordinateSpace,
} from "./canonicalPixels";

/**
 * Navigation graph summary for streaming to IDE plugins.
 */
export interface NavigationGraphStreamData {
  appId: string | null;
  nodes: Array<{
    id: number;
    screenName: string;
    visitCount: number;
    screenshotPath?: string | null;
  }>;
  edges: Array<{
    id: number;
    from: string;
    to: string;
    toolName: string | null;
    /** Number of times this transition has been traversed */
    traversalCount: number;
  }>;
  currentScreen: string | null;
}

/**
 * Performance metrics data for real-time streaming to IDE plugins.
 */
export interface PerformanceStreamData {
  /** Current FPS value */
  fps: number;
  /** Frame time in milliseconds */
  frameTimeMs: number;
  /** Number of janky frames (>16ms) in the last second */
  jankFrames: number;
  /** Total dropped frames since measurement started */
  droppedFrames: number;
  /** Memory usage in MB */
  memoryUsageMb: number;
  /** CPU usage percentage (0-100) */
  cpuUsagePercent: number;
  /** Touch latency in milliseconds (time from touch to frame response) */
  touchLatencyMs: number | null;
  /** Time to interactive in milliseconds (time until app is responsive after launch) */
  timeToInteractiveMs: number | null;
  /** Current screen/activity name if available */
  screenName: string | null;
  /** Whether the app is considered responsive */
  isResponsive: boolean;
  /** Total Compose recompositions since the last observation (null if no data) */
  recompositionCount: number | null;
  /** Compose recompositions per second rolling average (null if no data) */
  recompositionRate: number | null;
}

/** Package build identity carried by device build-context updates. */
export interface DeviceBuildKey {
  packageId: string;
  versionCode: number;
  versionKey?: string;
  contentHash: string;
}

/**
 * Response/push message format
 */
interface DeviceDataStreamMessage extends ScreenshotMetadata {
  id?: string;
  subscriptionId?: string;
  type:
    | "subscription_response"
    | "hierarchy_update"
    | "screenshot_update"
    | "navigation_update"
    | "device_build_context"
    | "performance_update"
    | "storage_update"
    | "storage_reconciliation_required"
    | "device_session_started"
    | "device_session_ended"
    | "ping"
    | "pong"
    | "error";
  success?: boolean;
  error?: string;
  packageName?: string;
  /** Present only on device_build_context; null clears this package's key. */
  buildKey?: DeviceBuildKey | null;
  packageId?: string;
  fileName?: string;
  deviceId?: string;
  /**
   * Stable device-session routing key for this frame's device epoch (epic #5256,
   * item 3). Present on every device-attributed frame — resolved from `deviceId`
   * by the server at push time — and on the lifecycle frames. `null` when no live
   * epoch maps to the serial (e.g. a navigation broadcast with unknown provenance).
   */
  deviceSessionUuid?: string | null;
  /** New epoch's uuid when a `device_session_ended` frame represents replacement. */
  successorSessionUuid?: string;
  reason?: DeviceSessionRetireReason;
  /** Device platform. Carried on `device_session_started`/`device_session_ended` frames. */
  platform?: Platform;
  timestamp?: number;
  data?: ViewHierarchyResult;
  screenshotBase64?: string;
  screenWidth?: number;
  screenHeight?: number;
  /** Device display rotation captured with this hierarchy or screenshot frame. */
  rotation?: number;
  navigationGraph?: NavigationGraphStreamData;
  performanceData?: PerformanceStreamData;
  storageEvent?: StorageChangedEvent;
  /** Per-frame hierarchy diff summary (present on hierarchy_update messages). */
  hierarchyDiff?: HierarchyDiffSummary;
  /**
   * Shared capture identity for the device geometry a message describes (issue #3348).
   *
   * Monotonic and never reset for the lifetime of the process, so an id can never be reused after
   * a device reconnect — a client still holding a pre-drop hierarchy must not be able to pair it
   * with a post-reconnect screenshot.
   *
   * Assigned on every `hierarchy_update`. A `screenshot_update` carries it ONLY when the daemon
   * verified that the frame's real pixel dimensions match the geometry the capture client claimed
   * for it (see `pushScreenshotUpdate`); otherwise the field is absent and a control client fails
   * closed. It is never inferred from "the latest hierarchy": a screenshot that captured fresh
   * pixels after a resolution change but before the next hierarchy arrived would otherwise be
   * stamped with the previous geometry's id and pair against stale mapping bounds.
   *
   * A control client pairs the two messages by requiring equal ids. Elapsed time cannot do this
   * job: after an aspect-preserving resolution change (1080x2340 -> 720x1560) a new screenshot and
   * a not-yet-applied older hierarchy are milliseconds apart and identical in aspect, yet mapping
   * a click through the old hierarchy's absolute bounds sends the wrong coordinate. Ids differ the
   * instant the geometry does, at any delta.
   */
  captureSequence?: number;
  /**
   * Coordinate space of this message's geometry (element bounds, screen dimensions) — `"px"` for
   * canonical physical pixels (issue #4549). Present only when the runner supplied complete scale
   * metadata; ABSENT means legacy point-space, so a control client (and #4550's exact geometry
   * checks) can tell converted frames from a pre-#4548 runner's and fall back accordingly.
   */
  coordinateSpace?: CoordinateSpace;
  /**
   * Point-to-physical-pixel ratio for a canonical-pixel frame. Present exactly with
   * `coordinateSpace: "px"` so clients can scale physical gesture thresholds precisely.
   */
  nativeScale?: number;
  /** Opaque device-authored UI identity used by input validation. */
  frameContext?: string;
}

/**
 * Whether a frame's MEASURED pixel dimensions are consistent with the geometry its capture client
 * claimed for it (issue #3348).
 *
 * Either orientation is accepted. Hierarchy geometry is display-oriented while screenshots can
 * arrive in native portrait pixel orientation — the rotation the renderer already corrects for — so
 * a 2532x1170 landscape claim legitimately accompanies a 1170x2532 PNG. Rejecting that would strip
 * the capture identity from every landscape frame on iOS and make device control impossible in that
 * orientation.
 *
 * A swap is still a strong check: it admits exactly one alternative, so a genuine scale change
 * (720x1560 pixels against a 1080x2340 claim) and any unrelated size are both still rejected. An
 * unmeasurable frame is never a match.
 *
 * This is the DAEMON-side pairing check only. A client's LIVE-mirror geometry check stays strict —
 * a mirror frame is always display-oriented, so a swap there means the sources are out of sync.
 */
function pixelsMatchClaimedGeometry(
  measured: { width: number; height: number } | null,
  claimedWidth: number | undefined,
  claimedHeight: number | undefined,
): boolean {
  if (measured === null || claimedWidth === undefined || claimedHeight === undefined) {
    return false;
  }
  const sameOrientation = measured.width === claimedWidth && measured.height === claimedHeight;
  const swappedOrientation = measured.width === claimedHeight && measured.height === claimedWidth;
  return sameOrientation || swappedOrientation;
}

/**
 * Per-push options for {@link DeviceDataStreamSocketServer.pushScreenshotUpdate}.
 */
interface PushScreenshotOptions {
  initialFrameSubscriber?: InitialFrameSubscriber;
  /** Caller already holds the decoded bytes of `screenshotBase64`; reuse them to measure geometry. */
  decodedImage?: Buffer;
  /**
   * The capture identity this frame belongs to, bound by the caller when it INITIATED the
   * screenshot request — not looked up here at delivery time.
   *
   * Delivery-time lookup is unsafe for a reason no measurement can catch: a frame captured on
   * screen A can be pushed after a hierarchy for screen B has already been forwarded. Ordinary
   * navigation keeps the resolution identical, so the header check passes and A's pixels would be
   * stamped with B's identity and pair cleanly, letting a control client tap stale content.
   *
   * Omitted by callers with no such provenance (e.g. `TakeScreenshot`, whose dimensions come from
   * the PNG it just captured). Those frames never carry a capture identity, so a control client
   * fails closed instead of pairing them with an unrelated hierarchy.
   */
  captureSequence?: number;
  /**
   * Set to `"px"` when the caller's device is publishing canonical physical pixels (issue #4549) —
   * i.e. the runner supplied complete scale metadata. Stamps `coordinateSpace: "px"` on the
   * screenshot so a control client reads the published `screenWidth`/`screenHeight` as pixels;
   * omitted for a pre-#4548 runner, keeping the frame legacy point-space.
   */
  coordinateSpace?: CoordinateSpace;
  /**
   * Native scale bound when the screenshot request was initiated. It travels with the frame for
   * the same reason as `coordinateSpace`: a later hierarchy must not relabel in-flight pixels.
   */
  nativeScale?: number;
  frameContext?: string;
  /** Device rotation reported by the platform when this screenshot was captured. */
  rotation?: number;
}

/**
 * Filter for device data stream subscriptions.
 *
 * `deviceSessionUuid` is the primary routing key (epic #5256, item 3): frame
 * delivery matches on it (`null` = every device). `deviceId` is the serial
 * resolved from that uuid at subscribe time and is used ONLY by the serial-scoped
 * cadence/polling machinery (which device to poll, at what interval) — it is never
 * the delivery key. The two are separated on purpose: routing is epoch-stable,
 * polling is inherently serial-addressed.
 */
interface DeviceDataFilter {
  deviceSessionUuid: string | null; // null means subscribe to all devices
  /**
   * Serial resolved from deviceSessionUuid, for cadence only. A non-null UUID
   * that cannot be resolved remains null: it is a no-device subscription, not
   * an all-devices subscription.
   */
  deviceId: string | null;
  screenshotIntervalMs: number | null;
  hierarchyIntervalMs: number | null;
}

/**
 * Push data wrapper - used internally for type safety with base class. Routing is
 * on `targetDeviceSessionUuid`; `null` reaches only all-device (`null`-filter)
 * subscribers (there is no cross-device broadcast — see `matchesFilter`).
 */
interface DeviceDataPush {
  message: DeviceDataStreamMessage;
  targetDeviceSessionUuid: string | null;
  targetFilter?: DeviceDataFilter;
}

/**
 * Callback invoked when a subscriber connects.
 * Can be used to trigger device WebSocket connections for real-time updates.
 */
export interface InitialFrameSubscriber {
  subscriptionId: string;
  signal: AbortSignal;
  /** Cached delivery must not restore an older frame's global input context or diff baseline. */
  replay?: boolean;
  /** Reuse the identity of a shared capture for joined and cached deliveries. */
  captureSequence?: number;
  frameContextGeneration?: number;
  liveFrameGeneration?: number;
  /** Routing identity bound before the initial capture starts. */
  deviceSessionUuid?: string | null;
}

export type OnSubscriberConnectedCallback = (
  deviceId: string | null,
  subscriber: InitialFrameSubscriber,
) => void;

/**
 * Callback invoked when active screenshot cadence may have changed for a device.
 */
export type OnScreenshotCadenceChangedCallback = (deviceId: string | null) => void;

/**
 * Callback invoked when active hierarchy cadence may have changed for a device.
 */
export type OnHierarchyCadenceChangedCallback = (deviceId: string | null) => void;

/**
 * Observation captured on demand for a stream client.
 */
export interface RequestedObservation {
  deviceId: string;
  observation: ObserveResult;
}

/**
 * Callback invoked when a client requests an immediate observation.
 */
export type OnObservationRequestedCallback = (request: {
  deviceId: string | null;
  sessionUuid?: string;
  requestId?: string;
  signal: AbortSignal;
}) => Promise<RequestedObservation[]>;

/**
 * Callback invoked when a client requests the current navigation graph.
 * Returns the current graph data, or null if no graph is available.
 */
export type OnNavigationGraphRequestedCallback = (
  appId?: string | null,
) => Promise<NavigationGraphStreamData | null>;

/**
 * Callback invoked when a client asks to (un)subscribe a device-side content observer for one
 * key/value store, so external writes to it emit `storage_update` frames. `deviceId` is the
 * resolved device the request targets (null when the client did not scope it). Best-effort: the
 * daemon logs and continues on failure rather than tearing down the stream (issue #4709).
 */
export type OnStorageSubscriptionRequestedCallback = (request: {
  deviceId: string | null;
  sessionUuid?: string;
  packageName: string;
  fileName: string;
  subscribe: boolean;
}) => Promise<void>;

/** One device-side observer, shared by every connected desktop stream that owns it. */
interface StorageSubscriptionState {
  deviceId: string | null;
  packageName: string;
  fileName: string;
  owners: Set<Socket>;
}

// iOS observe (ViewHierarchy.getiOSViewHierarchy -> getLatestHierarchy) can
// legitimately wait up to 15s for a fresh hierarchy. Keep this wrapper timeout
// above that so slow-but-valid iOS captures are not reported as stream errors
// before the platform observe path has its allotted time to complete.
export const DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_SCREENSHOT_INTERVAL_MS = 3000;
const DEFAULT_HIERARCHY_INTERVAL_MS = 1000;
const MIN_SCREENSHOT_INTERVAL_MS = 250;
const MIN_HIERARCHY_INTERVAL_MS = 250;
const MAX_SCREENSHOT_INTERVAL_MS = 2_147_483_647;
const MAX_HIERARCHY_INTERVAL_MS = 2_147_483_647;

// With no live-view subscriber, the host must NOT instruct the runner to poll
// the (expensive) accessibility hierarchy at the fast default cadence. Send this
// effectively-paused interval instead and rely on the on-demand
// `request_hierarchy_if_stale` path for observes; a subscriber appearing
// restores fast cadence via the same cadence-refresh call. This mirrors the
// screenshot stream, which is already `hasSubscriberForDevice`-gated (#5472).
const PAUSED_HIERARCHY_INTERVAL_MS = MAX_HIERARCHY_INTERVAL_MS;

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
  private readonly liveFrameGenerations = new Map<string, number>();
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
  private readonly buildKeysByDevice = new Map<
    string,
    { deviceSessionUuid: string; keys: Map<string, DeviceBuildKey> }
  >();
  private readonly suspendedRoutingLog = new SuspendedDeviceRoutingLog();
  private readonly initialFrameWaiters = new Map<string, AbortController>();
  private onSubscriberConnected: OnSubscriberConnectedCallback | null = null;
  private onScreenshotCadenceChanged: OnScreenshotCadenceChangedCallback | null = null;
  private onHierarchyCadenceChanged: OnHierarchyCadenceChangedCallback | null = null;
  private onObservationRequested: OnObservationRequestedCallback | null = null;
  private onNavigationGraphRequested: OnNavigationGraphRequestedCallback | null = null;
  private onStorageSubscriptionRequested: OnStorageSubscriptionRequestedCallback | null = null;
  /**
   * Storage observers are daemon-owned resources rather than one-command side effects. Track the
   * desktop sockets that own each observer so one pane closing cannot unsubscribe another pane,
   * and so a newly connected Android runner can restore all active observers.
   */
  private readonly storageSubscriptions = new Map<string, StorageSubscriptionState>();
  private readonly storageSubscriptionKeysBySocket = new Map<Socket, Set<string>>();
  /** Serializes lifecycle operations for one device-side storage observer. */
  private readonly storageOperations = new Map<string, Promise<void>>();
  private observationRequestTimeoutMs = DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS;

  // Previous hierarchy per device, used to compute the per-frame diff annotation
  // pushed on hierarchy_update. Cleared on device connection loss so a reconnect
  // starts from a clean baseline instead of diffing against a stale pre-drop tree.
  private previousHierarchyByDevice = new Map<string, ViewHierarchyResult>();

  // Source of capture ids (issue #3348). Process-wide and NEVER reset, so an id cannot be reused
  // after a reconnect and collide with a pre-drop hierarchy a client still holds. The current id
  // per device is deliberately NOT tracked here: callers bind it when they initiate a screenshot
  // request and hand it back on push, which is the only way to survive same-resolution navigation.
  private nextCaptureSequence = 1;

  constructor(
    socketPath: string = getSocketPath(DEVICE_DATA_STREAM_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    private readonly authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "observationStream",
      { allowObserverSessions: true },
    ),
  ) {
    super(socketPath, timer, "DeviceDataStream");
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
    const subscriber = target ? this.subscribers.get(target.subscriptionId) : undefined;
    if (target && (target.signal.aborted || !subscriber || subscriber.socket.destroyed)) {
      return 0;
    }
    const deviceSessionUuid = this.deviceSessionResolver.resolveUuid(deviceId);
    if (message.type === "device_build_context" && !target) {
      this.cacheBuildContext(deviceId, deviceSessionUuid, message);
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
    this.onScreenshotCadenceChanged = callback;
  }

  /**
   * Set a callback to be invoked when active hierarchy polling cadence may have changed.
   */
  setOnHierarchyCadenceChanged(callback: OnHierarchyCadenceChangedCallback): void {
    this.onHierarchyCadenceChanged = callback;
  }

  /**
   * Set a callback to handle on-demand observation requests.
   */
  setOnObservationRequested(
    callback: OnObservationRequestedCallback,
    timeoutMs: number = DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS,
  ): void {
    this.onObservationRequested = callback;
    this.observationRequestTimeoutMs = timeoutMs;
  }

  /**
   * Set a callback to handle on-demand navigation graph requests.
   */
  setOnNavigationGraphRequested(callback: OnNavigationGraphRequestedCallback): void {
    this.onNavigationGraphRequested = callback;
  }

  /**
   * Set a callback to handle per-file storage (un)subscription requests, so the daemon can register
   * the device-side content observer that produces `storage_update` frames.
   */
  setOnStorageSubscriptionRequested(callback: OnStorageSubscriptionRequestedCallback): void {
    this.onStorageSubscriptionRequested = callback;
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
    const {
      screenshotMimeType,
      screenshotFormat,
      screenshotCaptureSource,
      screenshotFallback,
      screenshotFallbackReason,
      screenshotCaptureDurationMs,
      screenshotEncodeDurationMs,
      screenshotByteLength,
      screenshotBase64Length,
    } = metadata;
    // The caller's screenWidth/screenHeight are a CLAIM about this frame's geometry, not a
    // measurement: the CtrlProxy clients read them from a screen-dimension cache derived from the
    // last hierarchy they processed. When the device resolution changes, a screenshot can carry
    // fresh pixels while that cache — and therefore the claim — is still the previous geometry.
    //
    // So measure the frame instead of trusting the claim. CtrlProxy never downscales (Android
    // compresses at fixed quality, iOS returns the native-scale PNG), so the header dimensions are
    // the frame's true geometry.
    const measured = readImageHeaderDimensions(
      options.decodedImage ?? Buffer.from(screenshotBase64, "base64"),
    );
    const claimMatchesPixels = pixelsMatchClaimedGeometry(measured, screenWidth, screenHeight);

    const message: DeviceDataStreamMessage = {
      type: "screenshot_update",
      deviceId,
      timestamp: this.timer.now(),
      screenshotBase64,
      // Publish the measured geometry when we have it, so a client that falls back to these
      // dimensions for coordinate mapping maps through the pixels it is actually rendering.
      ...(measured
        ? { screenWidth: measured.width, screenHeight: measured.height }
        : {
            ...(screenWidth === undefined ? {} : { screenWidth }),
            ...(screenHeight === undefined ? {} : { screenHeight }),
          }),
      // Stamp the identity the caller BOUND at request initiation, and only when the frame's real
      // pixels also match the geometry that binding carried. The binding is what survives
      // same-resolution navigation; the pixel check is the backstop that still catches a geometry
      // change between binding and delivery. An unmeasurable frame is equally unproven. In every
      // other case the field is omitted and the control client fails closed rather than pairing
      // against mapping bounds that may not describe these pixels.
      captureSequence: claimMatchesPixels ? options.captureSequence : undefined,
      ...(options.coordinateSpace ? { coordinateSpace: options.coordinateSpace } : {}),
      ...(options.nativeScale === undefined ? {} : { nativeScale: options.nativeScale }),
      frameContext: options.frameContext,
      rotation: options.rotation,
      screenshotMimeType,
      screenshotFormat,
      screenshotCaptureSource,
      screenshotFallback,
      screenshotFallbackReason,
      screenshotCaptureDurationMs,
      screenshotEncodeDurationMs,
      screenshotByteLength,
      screenshotBase64Length,
    };
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
    this.buildKeysByDevice.delete(record.deviceId);
    // Full: registry epoch start/replacement binds a new connection/incarnation.
    this.invalidateDeviceFrames(record.deviceId);
    this.pushDeviceSessionLifecycle("device_session_started", record);
  }

  pushDeviceSessionEnded(record: DeviceSessionRecord, options?: DeviceSessionEndOptions): void {
    this.buildKeysByDevice.delete(record.deviceId);
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
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.backfilling || subscriber.socket.destroyed) {
        continue;
      }

      if (this.subscriberWantsDevice(subscriber.filter, deviceId)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Whether a subscription's serial-scoped cadence applies to this device. This is
   * the POLLING question (which serial to poll, how fast), kept separate from frame
   * routing (`matchesFilter`, on `deviceSessionUuid`): the cadence machinery is
   * inherently serial-addressed, and `filter.deviceId` is the serial resolved for
   * exactly this purpose. Only a `null` `deviceSessionUuid` means all devices;
   * a non-null UUID with a null `deviceId` schedules none.
   */
  private subscriberWantsDevice(filter: DeviceDataFilter, deviceId: string): boolean {
    return (
      filter.deviceSessionUuid === null ||
      (filter.deviceId === deviceId &&
        this.deviceSessionResolver.resolveUuid(deviceId) === filter.deviceSessionUuid)
    );
  }

  /**
   * Return the fastest active screenshot cadence requested for this device,
   * or the default low-cost keepalive cadence when none is requested.
   */
  getScreenshotIntervalMsForDevice(deviceId: string): number {
    return this.getFastestIntervalMsForDevice(
      deviceId,
      DEFAULT_SCREENSHOT_INTERVAL_MS,
      (filter) => filter.screenshotIntervalMs,
      true,
    );
  }

  /**
   * Return the fastest active hierarchy cadence requested for this device,
   * or the default iOS hierarchy polling cadence when none is requested.
   */
  getHierarchyIntervalMsForDevice(
    deviceId: string,
    defaultIntervalMs: number = DEFAULT_HIERARCHY_INTERVAL_MS,
  ): number {
    // Subscriber-gate the hierarchy cadence: with no active subscriber, pause
    // runner polling entirely (observes still refresh on demand via
    // request_hierarchy_if_stale) rather than falling back to the 1Hz default.
    if (!this.hasSubscriberForDevice(deviceId)) {
      return PAUSED_HIERARCHY_INTERVAL_MS;
    }
    return this.getFastestIntervalMsForDevice(
      deviceId,
      defaultIntervalMs,
      (filter) => filter.hierarchyIntervalMs,
      false,
    );
  }

  private getFastestIntervalMsForDevice(
    deviceId: string,
    defaultIntervalMs: number,
    getRequestedIntervalMs: (filter: DeviceDataFilter) => number | null,
    useDefaultWhenRequestMissing: boolean,
  ): number {
    let fastestIntervalMs: number | null = null;

    for (const subscriber of this.subscribers.values()) {
      if (subscriber.backfilling || subscriber.socket.destroyed) {
        continue;
      }

      if (!this.subscriberWantsDevice(subscriber.filter, deviceId)) {
        continue;
      }

      const requestedIntervalMs = getRequestedIntervalMs(subscriber.filter);
      if (requestedIntervalMs === null && !useDefaultWhenRequestMissing) {
        continue;
      }
      const intervalMs = requestedIntervalMs ?? defaultIntervalMs;

      fastestIntervalMs =
        fastestIntervalMs === null ? intervalMs : Math.min(fastestIntervalMs, intervalMs);
    }

    return fastestIntervalMs ?? defaultIntervalMs;
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
      await this.handleNavigationGraphRequest(socket, request);
      return;
    }

    // Handle per-file storage (un)subscription: register/release a device-side content observer so
    // external writes to a key/value store emit storage_update frames.
    if (request.command === "subscribe_storage" || request.command === "unsubscribe_storage") {
      await this.handleStorageSubscriptionRequest(socket, request);
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
        this.notifyCadenceChangedForFilter(filter);
      }
      return;
    }

    // Update the requested cadence for an existing subscription in place, without a
    // resubscribe (which would leak a duplicate subscriber and re-trigger backfill). Lets a
    // subscriber raise the cadence while it is actively viewing the device and relax it when
    // backgrounded. Older daemons reply with a benign "unknown command" error.
    if (request.command === "update_cadence") {
      this.handleCadenceUpdate(socket, request);
      return;
    }

    // Delegate to base class for standard commands (subscribe, unsubscribe, pong)
    await super.processLine(socket, line);
  }

  private async handleNavigationGraphRequest(
    socket: Socket,
    request: { id?: string; sessionUuid?: string; deviceSessionUuid?: string; appId?: string },
  ): Promise<void> {
    try {
      const deviceSessionUuid = this.parseDeviceSessionUuid(request.deviceSessionUuid);
      const deviceId =
        deviceSessionUuid === null
          ? undefined
          : (this.deviceSessionResolver.resolveDeviceId(deviceSessionUuid) ?? undefined);
      if (deviceSessionUuid !== null && deviceId === undefined) {
        throw this.deviceSessionResolver.getSessionError(deviceSessionUuid);
      }
      this.authenticator.authorize({ sessionUuid: request.sessionUuid, deviceId });
      if (!this.onNavigationGraphRequested) {
        this.sendJson(socket, {
          id: request.id,
          type: "subscription_response",
          success: true,
        } satisfies SubscriptionResponse);
        return;
      }
      const graphData = await this.onNavigationGraphRequested(request.appId ?? null);
      if (graphData) {
        // Echo the requester's device-session key so the pane can attribute this
        // on-demand response to its own device (epic #5256, item 3; #4837 AC2).
        const message: DeviceDataStreamMessage = {
          id: request.id,
          type: "navigation_update",
          deviceSessionUuid,
          deviceId,
          timestamp: this.timer.now(),
          navigationGraph: graphData,
        };
        this.sendJson(socket, message);
      } else {
        const response: SubscriptionResponse = {
          id: request.id,
          type: "subscription_response",
          success: true,
        };
        this.sendJson(socket, response);
      }
    } catch (error) {
      logger.warn(`[DeviceDataStream] Error handling request_navigation_graph: ${error}`);
      const errorResponse: SubscriptionResponse = {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...deviceSessionErrorFields(error),
      };
      this.sendJson(socket, errorResponse);
    }
  }

  private handleCadenceUpdate(
    socket: Socket,
    request: {
      id?: string;
      subscriptionId?: string;
      screenshotIntervalMs?: unknown;
      hierarchyIntervalMs?: unknown;
    },
  ): void {
    const filter = request.subscriptionId
      ? this.findSubscriber(socket, request.subscriptionId)?.filter
      : undefined;
    if (!filter) {
      const errorResponse: SubscriptionResponse = {
        id: request.id,
        type: "error",
        success: false,
        error: request.subscriptionId
          ? `subscriptionId '${request.subscriptionId}' is not active; resubscribe before updating cadence`
          : "subscriptionId is required; resubscribe before updating cadence",
      };
      this.sendJson(socket, errorResponse);
      return;
    }

    filter.screenshotIntervalMs = this.parseScreenshotIntervalMs(request.screenshotIntervalMs);
    filter.hierarchyIntervalMs = this.parseHierarchyIntervalMs(request.hierarchyIntervalMs);
    const response: SubscriptionResponse = {
      id: request.id,
      type: "subscription_response",
      success: true,
    };
    this.sendJson(socket, response);
    this.notifyCadenceChangedForFilter(filter);
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
    await super.processLine(socket, line);

    // The wire now targets a deviceSessionUuid; the cadence/connect machinery is
    // serial-scoped, so resolve to the current serial. A missing UUID is an
    // intentional all-device subscription; an unresolvable UUID schedules no
    // device and must not be treated as that all-device case.
    if (deviceSessionUuid === null || subscribedDeviceId !== null) {
      this.notifyScreenshotCadenceChanged(subscribedDeviceId);
      this.notifyHierarchyCadenceChanged(subscribedDeviceId);
    }
  }

  protected onSubscribed(subscriptionId: string, filter: DeviceDataFilter, _socket: Socket): void {
    const controller = new AbortController();
    this.initialFrameWaiters.set(subscriptionId, controller);
    this.replayBuildContexts({ subscriptionId, signal: controller.signal, replay: true });
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
    if (buildKey?.contentHash === "") {
      if (!this.buildKeysByDevice.get(deviceId)?.keys.has(packageId)) {
        return;
      }
      buildKey = null;
    }
    this.pushForDevice(deviceId, {
      type: "device_build_context",
      deviceId,
      packageId,
      timestamp: this.timer.now(),
      buildKey: buildKey === null ? null : { ...buildKey, packageId },
    });
  }

  private cacheBuildContext(
    deviceId: string,
    deviceSessionUuid: string | null,
    message: DeviceDataStreamMessage,
  ): void {
    const previous = this.buildKeysByDevice.get(deviceId);
    if (previous?.deviceSessionUuid !== deviceSessionUuid) {
      this.buildKeysByDevice.delete(deviceId);
    }
    // Unbound serials still reach all-device subscribers but never seed replay for a future epoch.
    if (deviceSessionUuid === null || !message.packageId) {
      return;
    }
    const entry = this.buildKeysByDevice.get(deviceId) ?? {
      deviceSessionUuid,
      keys: new Map<string, DeviceBuildKey>(),
    };
    if (message.buildKey) {
      entry.keys.set(message.packageId, { ...message.buildKey });
    } else {
      entry.keys.delete(message.packageId);
    }
    if (entry.keys.size > 0) {
      this.buildKeysByDevice.set(deviceId, entry);
    } else {
      this.buildKeysByDevice.delete(deviceId);
    }
  }

  private replayBuildContexts(target: InitialFrameSubscriber): void {
    for (const [deviceId, entry] of this.buildKeysByDevice) {
      if (this.deviceSessionResolver.resolveUuid(deviceId) !== entry.deviceSessionUuid) {
        continue;
      }
      for (const [packageId, buildKey] of entry.keys) {
        this.pushForDevice(
          deviceId,
          {
            type: "device_build_context",
            deviceId,
            packageId,
            timestamp: this.timer.now(),
            buildKey,
          },
          target,
        );
      }
    }
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
    super.onServerClosing();
    this.abortRemovedInitialFrameWaiters();
  }

  protected onConnectionClose(socket: Socket): void {
    const filters = this.getSubscribersForSocket(socket).map((subscriber) => subscriber.filter);
    super.onConnectionClose(socket);
    this.abortRemovedInitialFrameWaiters();
    this.releaseStorageSubscriptionsForSocket(socket, false);
    for (const filter of filters) {
      this.notifyCadenceChangedForFilter(filter);
    }
  }

  protected onConnectionError(socket: Socket, error: Error): void {
    const filters = this.getSubscribersForSocket(socket).map((subscriber) => subscriber.filter);
    super.onConnectionError(socket, error);
    this.abortRemovedInitialFrameWaiters();
    this.releaseStorageSubscriptionsForSocket(socket, true);
    for (const filter of filters) {
      this.notifyCadenceChangedForFilter(filter);
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
        this.notifyCadenceChangedForFilter(filter);
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
      screenshotIntervalMs: this.parseScreenshotIntervalMs(request.screenshotIntervalMs),
      hierarchyIntervalMs: this.parseHierarchyIntervalMs(request.hierarchyIntervalMs),
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
    const subscriptions = [...this.storageSubscriptions.entries()].filter(
      ([, subscription]) => subscription.deviceId === deviceId,
    );
    for (const [key, subscription] of subscriptions) {
      try {
        await this.queueStorageOperation(key, {
          ...subscription,
          subscribe: subscription.owners.size > 0,
        });
        this.notifyStorageReconciliationRequired(deviceId, subscription);
        this.removeStorageSubscriptionIfUnowned(key, subscription);
      } catch (error) {
        logger.warn(
          `[DeviceDataStream] Failed to replay storage observer lifecycle for ${subscription.packageName}/${subscription.fileName}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private notifyStorageReconciliationRequired(
    deviceId: string,
    subscription: StorageSubscriptionState,
  ): void {
    for (const owner of subscription.owners) {
      this.sendJson(owner, {
        type: "storage_reconciliation_required",
        deviceId,
        packageName: subscription.packageName,
        fileName: subscription.fileName,
      });
    }
  }

  private async subscribeStorageForSocket(
    socket: Socket,
    key: string,
    request: {
      deviceId: string | null;
      packageName: string;
      fileName: string;
      subscribe: boolean;
    },
  ): Promise<void> {
    const existing = this.storageSubscriptions.get(key);
    if (existing) {
      this.addStorageSubscriptionOwner(socket, key, existing);
      try {
        if (existing.owners.size === 1) {
          // A prior final-owner teardown failed and left a zero-owner tombstone. Queue a fresh
          // registration rather than treating the retained record as a live observer.
          await this.queueStorageOperation(key, request);
        } else {
          await this.storageOperations.get(key);
        }
      } catch (error) {
        // This socket joined a registration already in flight. If it fails, it never acquired an
        // observer and must not leave a stale owner that makes later retries appear successful.
        this.removeStorageSubscriptionOwner(socket, key, existing);
        throw error;
      }
      return;
    }

    const subscription: StorageSubscriptionState = {
      deviceId: request.deviceId,
      packageName: request.packageName,
      fileName: request.fileName,
      owners: new Set(),
    };
    this.storageSubscriptions.set(key, subscription);
    this.addStorageSubscriptionOwner(socket, key, subscription);
    try {
      await this.queueStorageOperation(key, request);
    } catch (error) {
      this.removeStorageSubscriptionOwner(socket, key, subscription);
      throw error;
    }
  }

  private async unsubscribeStorageForSocket(
    socket: Socket,
    key: string,
    request: {
      deviceId: string | null;
      packageName: string;
      fileName: string;
      subscribe: boolean;
    },
  ): Promise<void> {
    const subscription = this.storageSubscriptions.get(key) ?? null;
    if (!subscription || !this.removeStorageSubscriptionOwner(socket, key, subscription)) {
      return;
    }
    if (subscription.owners.size === 0) {
      // Preserve a socket-owned tombstone while the final teardown is in flight. If CtrlProxy is
      // transiently unavailable, connection close or runner reconnect can retry it instead of
      // losing the only record of the device-side observer.
      this.retainStorageSubscriptionKeyForSocket(socket, key);
      await this.queueStorageOperation(key, request);
      this.forgetStorageSubscriptionKeyForSocket(socket, key);
      this.removeStorageSubscriptionIfUnowned(key, subscription);
    }
  }

  private addStorageSubscriptionOwner(
    socket: Socket,
    key: string,
    subscription: StorageSubscriptionState,
  ): void {
    if (!subscription.owners.add(socket)) {
      return;
    }
    this.retainStorageSubscriptionKeyForSocket(socket, key);
  }

  /**
   * Returns true only when [socket] actually owned the observer. The final owner removes the
   * record before awaiting teardown so a concurrent reconnect creates a new, ordered lifecycle.
   */
  private removeStorageSubscriptionOwner(
    socket: Socket,
    key: string,
    subscription: StorageSubscriptionState,
  ): boolean {
    if (!subscription.owners.delete(socket)) {
      return false;
    }
    this.forgetStorageSubscriptionKeyForSocket(socket, key);
    return true;
  }

  /** Release every observer owned by a desktop socket that disconnected without an explicit UI tear-down. */
  private releaseStorageSubscriptionsForSocket(socket: Socket, retainForCloseRetry: boolean): void {
    const keys = this.storageSubscriptionKeysBySocket.get(socket);
    if (!keys) {
      return;
    }
    for (const key of [...keys]) {
      const subscription = this.storageSubscriptions.get(key);
      if (!subscription) {
        this.forgetStorageSubscriptionKeyForSocket(socket, key);
        continue;
      }
      this.removeStorageSubscriptionOwner(socket, key, subscription);
      if (subscription.owners.size === 0) {
        // An error event is normally followed by close, so preserve its key long enough for that
        // second callback to retry. A close callback is terminal and must not retain the dead
        // socket; the ownerless subscription itself remains as a runner-reconnect tombstone.
        if (retainForCloseRetry) {
          this.retainStorageSubscriptionKeyForSocket(socket, key);
        } else {
          this.forgetStorageSubscriptionKeyForSocket(socket, key);
        }
        void this.queueStorageOperation(key, { ...subscription, subscribe: false }).then(
          () => {
            this.removeStorageSubscriptionIfUnowned(key, subscription);
            this.forgetStorageSubscriptionKeyForSocket(socket, key);
          },
          (error) => {
            logger.warn(
              `[DeviceDataStream] Failed to release storage observer for ${subscription.packageName}/${subscription.fileName}: ${errorMessage(error)}`,
            );
            if (!retainForCloseRetry) {
              this.forgetStorageSubscriptionKeyForSocket(socket, key);
            }
          },
        );
      }
    }
  }

  private retainStorageSubscriptionKeyForSocket(socket: Socket, key: string): void {
    const keys = this.storageSubscriptionKeysBySocket.get(socket) ?? new Set<string>();
    keys.add(key);
    this.storageSubscriptionKeysBySocket.set(socket, keys);
  }

  private forgetStorageSubscriptionKeyForSocket(socket: Socket, key: string): void {
    const keys = this.storageSubscriptionKeysBySocket.get(socket);
    keys?.delete(key);
    if (keys?.size === 0) {
      this.storageSubscriptionKeysBySocket.delete(socket);
    }
  }

  private removeStorageSubscriptionIfUnowned(
    key: string,
    subscription: StorageSubscriptionState,
  ): void {
    if (subscription.owners.size === 0 && this.storageSubscriptions.get(key) === subscription) {
      this.storageSubscriptions.delete(key);
    }
  }

  /** Queue an observer operation behind any prior command for the same device/package/file. */
  private queueStorageOperation(
    key: string,
    request: {
      deviceId: string | null;
      packageName: string;
      fileName: string;
      subscribe: boolean;
    },
  ): Promise<void> {
    if (!this.onStorageSubscriptionRequested) {
      return Promise.resolve();
    }
    const previous = this.storageOperations.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.onStorageSubscriptionRequested!(request));
    this.storageOperations.set(key, operation);
    void operation.finally(() => this.clearStorageOperation(key, operation)).catch(() => undefined);
    return operation;
  }

  private parseScreenshotIntervalMs(value: unknown): number | null {
    return this.parseClampedIntervalMs(
      value,
      MIN_SCREENSHOT_INTERVAL_MS,
      MAX_SCREENSHOT_INTERVAL_MS,
    );
  }

  private parseHierarchyIntervalMs(value: unknown): number | null {
    return this.parseClampedIntervalMs(value, MIN_HIERARCHY_INTERVAL_MS, MAX_HIERARCHY_INTERVAL_MS);
  }

  private parseClampedIntervalMs(
    value: unknown,
    minIntervalMs: number,
    maxIntervalMs: number,
  ): number | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return null;
    }

    return Math.min(Math.max(Math.round(value), minIntervalMs), maxIntervalMs);
  }

  private notifyScreenshotCadenceChanged(deviceId: string | null): void {
    this.notifyCadenceChanged(
      this.onScreenshotCadenceChanged,
      "onScreenshotCadenceChanged",
      deviceId,
    );
  }

  private notifyHierarchyCadenceChanged(deviceId: string | null): void {
    this.notifyCadenceChanged(
      this.onHierarchyCadenceChanged,
      "onHierarchyCadenceChanged",
      deviceId,
    );
  }

  private notifyCadenceChangedForFilter(filter: DeviceDataFilter): void {
    if (filter.deviceSessionUuid !== null && filter.deviceId === null) {
      return;
    }
    this.notifyScreenshotCadenceChanged(filter.deviceId);
    this.notifyHierarchyCadenceChanged(filter.deviceId);
  }

  private notifyCadenceChanged(
    callback: ((deviceId: string | null) => void) | null,
    callbackName: string,
    deviceId: string | null,
  ): void {
    if (!callback) {
      return;
    }

    try {
      callback(deviceId);
    } catch (error) {
      logger.warn(`[DeviceDataStream] Error in ${callbackName} callback: ${error}`);
    }
  }

  /**
   * Register or release a device-side content observer for one key/value file, so
   * external writes to it emit `storage_update` frames. The acknowledgement follows
   * the device-side result, so the desktop can safely reconcile its snapshot after
   * registration.
   */
  private async handleStorageSubscriptionRequest(
    socket: Socket,
    request: {
      id?: string;
      command: string;
      deviceId?: string;
      deviceSessionUuid?: string;
      sessionUuid?: string;
      packageName?: string;
      fileName?: string;
    },
  ): Promise<void> {
    const subscribe = request.command === "subscribe_storage";
    const { packageName, fileName } = request;
    if (!packageName || !fileName) {
      this.sendJson(socket, {
        id: request.id,
        type: "error",
        success: false,
        error: `${request.command} requires packageName and fileName`,
      } satisfies SubscriptionResponse);
      return;
    }

    let storageDeviceId: string | null;
    try {
      storageDeviceId = this.resolveStorageTargetDeviceId(request, subscribe);
      this.authenticator.authorize({
        sessionUuid: request.sessionUuid,
        deviceId: storageDeviceId ?? undefined,
      });
    } catch (error) {
      this.sendJson(socket, {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...deviceSessionErrorFields(error),
      } satisfies SubscriptionResponse);
      return;
    }

    // The CtrlProxy observer is keyed by serial/package/file, not by the session epoch. A
    // reconnecting pane receives a new session UUID for the same serial; keeping UUIDs in this
    // ownership key lets the retired pane's teardown unregister the refreshed pane's observer.
    const key = `${storageDeviceId ?? "all"}:${packageName}:${fileName}`;
    const storageRequest = {
      deviceId: storageDeviceId,
      sessionUuid: request.sessionUuid,
      packageName,
      fileName,
      subscribe,
    };
    try {
      if (subscribe) {
        await this.subscribeStorageForSocket(socket, key, storageRequest);
      } else {
        await this.unsubscribeStorageForSocket(socket, key, storageRequest);
      }
    } catch (error) {
      logger.warn(
        `[DeviceDataStream] Error handling ${request.command} for ${packageName}/${fileName}: ${errorMessage(error)}`,
      );
      this.sendJson(socket, {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...deviceSessionErrorFields(error),
      } satisfies SubscriptionResponse);
      return;
    }

    this.sendJson(socket, {
      id: request.id,
      type: "subscription_response",
      success: true,
    } satisfies SubscriptionResponse);
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
    try {
      const deviceSessionUuid = this.parseDeviceSessionUuid(request.deviceSessionUuid);
      const deviceId =
        deviceSessionUuid === null
          ? request.deviceId
          : (this.deviceSessionResolver.resolveDeviceId(deviceSessionUuid) ?? undefined);
      if (deviceSessionUuid !== null && deviceId === undefined) {
        throw this.deviceSessionResolver.getSessionError(deviceSessionUuid);
      }
      this.authenticator.authorize({ sessionUuid: request.sessionUuid, deviceId });
      if (!this.onObservationRequested) {
        throw new Error("Observation requests are not available");
      }
      // FUNNEL 2, BEFORE observing. A device-specific request names the serial,
      // and the quarantine is precisely the pool's inability to say which runtime
      // answers on it. Without this the handler observed the unknown runtime,
      // `pushForDevice` then dropped every frame because routing is suspended,
      // and the requester was acknowledged `success: true` with no hierarchy
      // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
      if (deviceId !== undefined) {
        this.deviceSessionResolver.assertDeviceActionable(deviceId, "to observe");
      }
      const frameContextGenerationsAtStart = new Map(this.frameContextGenerations);
      const untrackedGenerationAtStart = this.untrackedLiveFrameGeneration;
      const observations = await this.requestObservationWithTimeout({
        deviceId: deviceId ?? null,
        sessionUuid: request.sessionUuid,
        requestId: request.id,
      });
      if (observations.length === 0) {
        throw new Error("Observation request did not capture any devices");
      }

      const failures = this.pushObservedHierarchies(
        observations,
        frameContextGenerationsAtStart,
        untrackedGenerationAtStart,
      );

      if (failures.length > 0) {
        // Healthy devices already received their hierarchy_update pushes above;
        // report the per-device failures so the client can display/retry them.
        const errorResponse: SubscriptionResponse = {
          id: request.id,
          type: "error",
          success: false,
          error: failures.join("; "),
        };
        this.sendJson(socket, errorResponse);
        return;
      }

      const response: SubscriptionResponse = {
        id: request.id,
        type: "subscription_response",
        success: true,
      };
      this.sendJson(socket, response);
    } catch (error) {
      logger.warn(`[DeviceDataStream] Error handling request_observation: ${error}`);
      const errorResponse: SubscriptionResponse = {
        id: request.id,
        type: "error",
        success: false,
        error: errorMessage(error),
        ...deviceSessionErrorFields(error),
      };
      this.sendJson(socket, errorResponse);
    }
  }

  /**
   * Push each observed hierarchy independently and return the per-device
   * failures, so that for an all-device request a healthy device still receives
   * its refresh even when another device produced nothing. Failures are surfaced
   * in the response rather than aborting the batch.
   *
   * A device whose pooled identity is quarantined is one of those failures: FUNNEL
   * 2 cannot preflight an all-device request, which names no serial, and
   * `pushForDevice` would drop that serial's frames because routing is suspended —
   * delivering nothing while the requester is acknowledged `success: true`, the
   * same false acknowledgement the device-specific form was fixed for
   * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   */
  private pushObservedHierarchies(
    observations: readonly RequestedObservation[],
    frameContextGenerationsAtStart: ReadonlyMap<string, number>,
    untrackedGenerationAtStart: number,
  ): string[] {
    const failures: string[] = [];
    for (const { deviceId, observation } of observations) {
      if (this.deviceSessionResolver.isRoutingSuspended(deviceId)) {
        failures.push(
          `Observation request failed for ${deviceId}: its pooled AVD identity is unresolved, ` +
            "so there is no routing identity to attribute the hierarchy to",
        );
        continue;
      }
      const hierarchy = observation.viewHierarchy;
      if (!hierarchy) {
        failures.push(this.describeMissingHierarchy(deviceId, observation));
        continue;
      }
      if (
        this.getCurrentFrameContextGeneration(deviceId) !==
        (frameContextGenerationsAtStart.get(deviceId) ?? untrackedGenerationAtStart)
      ) {
        logger.debug(
          `[DeviceDataStream] Skipped stale explicit observation for ${deviceId}; a newer hierarchy or full boundary intervened`,
        );
        continue;
      }
      this.pushHierarchyUpdate(deviceId, hierarchy, hierarchy.frameContext);
    }
    return failures;
  }

  private describeMissingHierarchy(deviceId: string, observation: ObserveResult): string {
    const observationError =
      observation.error ??
      observation.errors?.map((error) => error.message).join("; ") ??
      "Observation did not include view hierarchy";
    return `Observation request failed for ${deviceId}: ${observationError}`;
  }

  private async requestObservationWithTimeout(request: {
    deviceId: string | null;
    sessionUuid?: string;
    requestId?: string;
  }): Promise<RequestedObservation[]> {
    const controller = new AbortController();
    return await raceWithDeadline(
      this.onObservationRequested!({
        deviceId: request.deviceId,
        sessionUuid: request.sessionUuid,
        requestId: request.requestId,
        signal: controller.signal,
      }),
      {
        timer: this.timer,
        timeoutMs: this.observationRequestTimeoutMs,
        label: "Observation request",
        timeoutError: () =>
          new Error(`Observation request timed out after ${this.observationRequestTimeoutMs}ms`),
        onTimeout: () => controller.abort(),
      },
    );
  }

  private clearStorageOperation(key: string, operation: Promise<void>): void {
    if (this.storageOperations.get(key) === operation) {
      this.storageOperations.delete(key);
    }
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
