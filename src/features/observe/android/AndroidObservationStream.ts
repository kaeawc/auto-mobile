import { COORDINATE_SPACE_PX } from "../../../daemon/canonicalPixels";
import { getDeviceDataStreamServer } from "../../../daemon/deviceDataStreamSocketServer";
import type { BootedDevice, ScreenScaleMetadata, ViewHierarchyResult } from "../../../models";
import { readScreenScaleMetadata } from "../../../models/ScreenScaleMetadata";
import { logger } from "../../../utils/logger";
import type {
  ScreenshotBackoffConfigInput,
  ScreenshotBackoffScheduler,
  ScreenshotCaptureResult,
} from "../ScreenshotBackoffScheduler";
import {
  ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
  type ScreenshotMetadata,
} from "../ScreenshotMetadata";
import {
  screenshotBindingPushOptions,
  type ScreenGeometryBinding,
  type TrackedScreenGeometry,
} from "../TrackedScreenGeometry";
import type { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import type { AccessibilityHierarchy } from "./types";

export interface AndroidObservationStreamContext {
  readonly device: Pick<BootedDevice, "deviceId">;
  readonly hierarchy: Pick<CtrlProxyHierarchy, "convertToViewHierarchyResult">;
  readonly screenGeometry: Pick<
    TrackedScreenGeometry,
    "width" | "height" | "clear" | "update" | "markForwarded"
  >;
  isCommandSupported(messageType: string): boolean;
  sendMessage(message: string): void;
  captureScreenshotForObservationStream(): Promise<ScreenshotCaptureResult>;
  startScreenshotBackoff(): void;
  pushScreenshotToObservationStream(
    screenshotBase64: string,
    options?: {
      metadata?: ScreenshotMetadata;
      binding?: ScreenGeometryBinding;
      frameContext?: string;
      rotation?: number;
    },
  ): void;
  createScreenshotBackoffScheduler(
    capture: () => Promise<ScreenshotCaptureResult>,
    emit: (result: ScreenshotCaptureResult) => void,
    options: ScreenshotBackoffConfigInput,
  ): ScreenshotBackoffScheduler;
  forwardHierarchyToObservationStream(
    hierarchy: ViewHierarchyResult,
    frameContext: string | undefined,
    hooks: { logTag: string; recordForwarded: (captureSequence: number) => void },
  ): void;
}
/** Owns geometry provenance, stream delivery, and subscriber-gated screenshot cadence. */
export class AndroidObservationStream {
  // Minimum interval between accessibility takeScreenshot() requests. The platform rate-limits
  // calls below its floor (~333ms, ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT); 350ms sits just
  // above it so a front-loaded backoff burst or an animation's restart storm cannot trip the
  // limit into needless ADB-screencap fallover (issue #4927).
  private static readonly A11Y_SCREENSHOT_MIN_INTERVAL_MS = 350;
  private static readonly DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS = 250;

  private readonly streamedCaptureSequences = new WeakMap<object, number>();
  private reportedScaleMetadata: ScreenScaleMetadata | null = null;
  constructor(private readonly context: AndroidObservationStreamContext) {}

  convertToViewHierarchyResult(
    accessibilityHierarchy: AccessibilityHierarchy,
  ): ViewHierarchyResult {
    const result = this.context.hierarchy.convertToViewHierarchyResult(accessibilityHierarchy);
    const captureSequence = this.streamedCaptureSequences.get(accessibilityHierarchy);
    if (captureSequence !== undefined) {
      result.captureSequence = captureSequence;
    }
    return result;
  }

  refreshObservationStreamHierarchyCadence(intervalMs?: number | null): void {
    if (!this.context.isCommandSupported("set_hierarchy_interval")) {
      logger.info(
        "[AndroidCtrlProxyClient] Skipping hierarchy cadence sync; runner does not advertise set_hierarchy_interval",
      );
      return;
    }

    const resolvedIntervalMs =
      intervalMs === undefined
        ? (getDeviceDataStreamServer()?.getHierarchyIntervalMsForDevice(
            this.context.device.deviceId,
            AndroidObservationStream.DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS,
          ) ?? AndroidObservationStream.DEFAULT_HIERARCHY_BROADCAST_INTERVAL_MS)
        : intervalMs;

    this.context.sendMessage(
      serializeCtrlProxyRequest(
        ctrlProxyRequests.setHierarchyInterval({
          intervalMs: resolvedIntervalMs,
        }),
      ),
    );
  }

  /** Converts wire to domain at the push; provenance stays keyed by the wire object. */
  public pushHierarchyToObservationStream(
    wireHierarchy: AccessibilityHierarchy,
    frameContext?: string,
  ): void {
    const hierarchy = this.context.hierarchy.convertToViewHierarchyResult(wireHierarchy);
    hierarchy.updatedAt = wireHierarchy.updatedAt || undefined; // stream timestamp source
    this.context.forwardHierarchyToObservationStream(hierarchy, frameContext, {
      logTag: "CTRL_PROXY",
      recordForwarded: (captureSequence) => {
        wireHierarchy.captureSequence = captureSequence;
        this.streamedCaptureSequences.set(wireHierarchy, captureSequence);
        this.context.screenGeometry.markForwarded(captureSequence);
      },
    });
  }

  /**
   * Bind the hierarchy explicitly forwarded by the daemon's subscriber bootstrap. The request
   * suppressed this client's normal stream push, so it must replace any prior provenance before
   * accepting the identity assigned by that explicit push, then start keepalives for a static
   * screen.
   */
  recordInitialObservationStreamHierarchy(
    hierarchy: ViewHierarchyResult,
    captureSequence: number | null,
  ): void {
    this.context.screenGeometry.clear();
    this.updateCachedScreenDimensions(hierarchy);
    if (captureSequence !== null) {
      this.context.screenGeometry.markForwarded(captureSequence);
    }
    this.context.startScreenshotBackoff();
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  pushScreenshotToObservationStream(
    screenshotBase64: string,
    {
      metadata = ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
      binding,
      frameContext,
      rotation,
    }: {
      metadata?: ScreenshotMetadata;
      binding?: ScreenGeometryBinding;
      frameContext?: string;
      rotation?: number;
    } = {},
  ): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    // Declare the geometry the request was BOUND to, not whatever the cache holds now — the two
    // differ exactly when a hierarchy arrived while this frame was in flight. Without a binding,
    // fall back to a nominal size and send no identity, so a control client fails closed.
    const screenWidth = binding?.width ?? this.context.screenGeometry.width ?? 1080;
    const screenHeight = binding?.height ?? this.context.screenGeometry.height ?? 2340;

    try {
      // The identity AND the coordinate space travel with the frame from the moment it was
      // requested (issues #3348, #4549) — both from the binding taken at initiation, never the
      // client's LATEST metadata at delivery. Android bounds are already physical pixels
      // (nativeScale === 1), so a post-#4548 runner's frame is canonical pixels as-is; the binding
      // carries that declaration so a mid-flight metadata flip cannot relabel the frame.
      server.pushScreenshotUpdate(
        this.context.device.deviceId,
        screenshotBase64,
        screenWidth,
        screenHeight,
        {
          metadata,
          options: {
            ...screenshotBindingPushOptions(binding),
            rotation,
            ...(frameContext === undefined ? {} : { frameContext }),
          },
        },
      );
    } catch (error) {
      // Stream delivery is best effort; a disconnected subscriber must not fail observation.
      logger.debug(`[CTRL_PROXY] Failed to push screenshot to observation stream: ${error}`);
    }
  }

  public updateCachedScreenDimensions(
    hierarchy: Pick<
      AccessibilityHierarchy,
      "windows" | "nativeScale" | "pixelWidth" | "pixelHeight"
    >,
  ): void {
    // Retain the additive #4548 scale metadata alongside — but never instead of — the
    // window-derived geometry below. Same freshness rule as the tracked geometry: a hierarchy
    // without the fields (pre-#4548 runner) resets it to null rather than leaving stale values.
    this.reportedScaleMetadata = readScreenScaleMetadata(hierarchy);
    const windows = hierarchy.windows;
    if (!windows || windows.length === 0) {
      this.context.screenGeometry.clear();
      return;
    }

    let maxArea = 0;
    let bestDimensions: { width: number; height: number } | null = null;

    for (const window of windows) {
      if (window.bounds) {
        const width = window.bounds.right - window.bounds.left;
        const height = window.bounds.bottom - window.bounds.top;
        const area = width * height;
        if (area > maxArea) {
          maxArea = area;
          bestDimensions = { width, height };
        }
      }
    }

    if (bestDimensions) {
      // A change clears the identity: it becomes capture-tracked only once the hierarchy carrying
      // it reaches the daemon (see pushHierarchyToObservationStream) — which will NOT happen when
      // this hierarchy is suppressed, or when there is no stream server. The coordinate space is
      // bound here (#4549) from the metadata present for THIS hierarchy, so a later metadata flip
      // cannot restamp a frame whose request was bound now.
      this.context.screenGeometry.update(
        bestDimensions.width,
        bestDimensions.height,
        this.reportedScaleMetadata ? COORDINATE_SPACE_PX : undefined,
        this.reportedScaleMetadata?.nativeScale,
      );
    } else {
      // No usable window bounds in this hierarchy. Clearing (rather than keeping the previous
      // entry) stops a later push from vouching for dimensions this hierarchy cannot confirm.
      this.context.screenGeometry.clear();
    }
  }

  /**
   * Runner-reported scale metadata from the most recent hierarchy (#4548), or null when the
   * runner has not reported it (pre-#4548 runner, or no hierarchy yet). Exposed for #4549's
   * canonical-pixel conversion; nothing in current behavior consumes it.
   */
  getScreenScaleMetadata(): ScreenScaleMetadata | null {
    return this.reportedScaleMetadata;
  }

  public getScreenshotBackoffScheduler(): ScreenshotBackoffScheduler {
    return this.context.createScreenshotBackoffScheduler(
      async () => this.captureScreenshotForBackoff(),
      (result) => this.emitBackoffScreenshot(result),
      {
        intervals: [0, 100, 300, 500, 800, 1300],
        keepAliveIntervalMs: 3000,
        minCaptureIntervalMs: AndroidObservationStream.A11Y_SCREENSHOT_MIN_INTERVAL_MS,
      },
    );
  }

  private emitBackoffScreenshot(result: ScreenshotCaptureResult): void {
    if (result.data) {
      this.context.pushScreenshotToObservationStream(result.data, {
        metadata: result,
        binding: result.captureBinding,
        frameContext: result.frameContext,
        rotation: result.rotation,
      });
    }
  }

  private async captureScreenshotForBackoff(): Promise<ScreenshotCaptureResult> {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.context.device.deviceId)) {
      return { success: false, error: "No subscribers" };
    }

    return this.context.captureScreenshotForObservationStream();
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  startScreenshotBackoff(): void {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.context.device.deviceId)) {
      return;
    }

    const scheduler = this.getScreenshotBackoffScheduler();
    scheduler.startBackoffSequence();
  }
}
