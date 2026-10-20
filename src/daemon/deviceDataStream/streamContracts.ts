import type { ObserveResult, Platform, ViewHierarchyResult } from "../../models";
import type { StorageChangedEvent } from "../../features/storage/storageTypes";
import type { ScreenshotMetadata } from "../../features/observe/ScreenshotMetadata";
import type { DeviceSessionRetireReason } from "../deviceSessionRegistry";
import type { HierarchyDiffSummary } from "../hierarchyStreamDiff";
import type { CoordinateSpace } from "../canonicalPixels";

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
export interface DeviceDataFilter {
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
export interface DeviceDataStreamMessage extends ScreenshotMetadata {
  id?: string;
  subscriptionId?: string;
  type:
    | "subscription_response"
    | "hierarchy_update"
    | "screenshot_update"
    | "frames_dropped"
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
  /** Congestion notice; no screenshot bytes are carried in this message. */
  droppedType?: "screenshot_update";
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
  reason?: DeviceSessionRetireReason | "backpressure";
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

/** Additive congestion notice preserving the dropped frame's device attribution. */
export interface FramesDroppedMessage extends Pick<
  DeviceDataStreamMessage,
  "subscriptionId" | "deviceId" | "deviceSessionUuid"
> {
  type: "frames_dropped";
  droppedType: "screenshot_update";
  reason: "backpressure";
}

/**
 * Per-push options for `pushScreenshotUpdate`.
 */
export interface PushScreenshotOptions {
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
 * Push data wrapper - used internally for type safety with base class. Routing is
 * on `targetDeviceSessionUuid`; `null` reaches only all-device (`null`-filter)
 * subscribers (there is no cross-device broadcast — see `matchesFilter`).
 */
export interface DeviceDataPush {
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
