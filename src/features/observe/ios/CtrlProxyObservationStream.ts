import type { Timer } from "../../../utils/SystemTimer";
import type { ViewHierarchyResult } from "../../../models";
import type { CoordinateSpace } from "../../../daemon/canonicalPixels";
import { COORDINATE_SPACE_PX } from "../../../daemon/canonicalPixels";
import type { CtrlProxyScreenshotResult, XCTestHierarchy } from "./types";
import { TrackedScreenGeometry } from "../TrackedScreenGeometry";
import type {
  ScreenshotBackoffScheduler,
  ScreenshotCaptureResult,
} from "../ScreenshotBackoffScheduler";
import {
  IOS_CTRLPROXY_SCREENSHOT_METADATA,
  metadataForScreenshotFormat,
  type ScreenshotMetadata,
} from "../ScreenshotMetadata";
import { getDeviceDataStreamServer } from "../../../daemon/deviceDataStreamSocketServer";
import { readScreenScaleMetadata } from "../../../models/ScreenScaleMetadata";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
export interface ScreenshotObservationStreamOptions {
  screenshotBase64: string;
  screenWidth: number;
  screenHeight: number;
  metadata?: ScreenshotMetadata;
  captureSequence?: number;
  coordinateSpace?: CoordinateSpace;
  nativeScale?: number;
  frameContext?: string;
  rotation?: number;
}
interface ObservationStreamHost {
  readonly timer: Timer;
  readonly deviceId: string;
  readonly screenGeometry: TrackedScreenGeometry;
  readonly streamedCaptureSequences: WeakMap<XCTestHierarchy, number>;
  requestScreenshot(timeoutMs: number): Promise<CtrlProxyScreenshotResult>;
  startScreenshotBackoff(): void;
  captureScreenshotForBackoff(): Promise<ScreenshotCaptureResult>;
  createScreenshotBackoffScheduler(
    capture: () => Promise<ScreenshotCaptureResult>,
    emit: (result: ScreenshotCaptureResult) => void,
  ): ScreenshotBackoffScheduler;
  forwardHierarchyToObservationStream(
    hierarchy: ViewHierarchyResult,
    frameContext: string | undefined,
    hooks: { logTag: string; prepare?: () => void; recordForwarded(captureSequence: number): void },
  ): void;
}

/** Hierarchy provenance and request-bound screenshot streaming. */
export class CtrlProxyObservationStream {
  suppressedRequestIds(): string[] {
    return [...this.hierarchyObservationStreamSuppressions.keys()];
  }
  constructor(private readonly host: ObservationStreamHost) {}

  private readonly hierarchyObservationStreamSuppressions: Map<string, NodeJS.Timeout> = new Map();

  suppressHierarchyObservationStreamPush(requestId: string, timeoutMs: number): void {
    const existingTimeout = this.hierarchyObservationStreamSuppressions.get(requestId);
    if (existingTimeout) {
      this.host.timer.clearTimeout(existingTimeout);
    }

    const timeoutHandle = this.host.timer.setTimeout(() => {
      this.hierarchyObservationStreamSuppressions.delete(requestId);
    }, timeoutMs);
    this.hierarchyObservationStreamSuppressions.set(requestId, timeoutHandle);
  }

  consumeHierarchyObservationStreamSuppression(requestId: string): boolean {
    const timeoutHandle = this.hierarchyObservationStreamSuppressions.get(requestId);
    if (!timeoutHandle) {
      return false;
    }

    this.hierarchyObservationStreamSuppressions.delete(requestId);
    this.host.timer.clearTimeout(timeoutHandle);
    return true;
  }

  /**
   * Push hierarchy update to the device data stream for IDE plugins.
   */
  pushHierarchyToObservationStream(
    hierarchy: ViewHierarchyResult,
    source: XCTestHierarchy | undefined,
    frameContext?: string,
  ): void {
    this.host.forwardHierarchyToObservationStream(hierarchy, frameContext, {
      logTag: "IOSCtrlProxyClient",
      prepare: () => {
        // Derive geometry from the hierarchy BEING FORWARDED, before the push, so the identity
        // recorded below belongs to the geometry it actually describes.
        //
        // Reading this.cachedHierarchy here would be wrong on the request/response path: processMessage
        // forwards the converted response before CtrlProxyHierarchy.requestHierarchySync resumes and
        // installs it in the cache, so the cache still holds the PREVIOUS hierarchy (or nothing at
        // all on the first response). A resolution-changing response would then associate its capture
        // id with the old dimensions and screenshots could not pair until another hierarchy arrived.
        this.updateScreenGeometryFrom(source);
      },
      recordForwarded: (captureSequence) => {
        if (source) {
          source.captureSequence = captureSequence;
          this.host.streamedCaptureSequences.set(source, captureSequence);
        }
        this.host.screenGeometry.markForwarded(captureSequence);
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
    this.host.screenGeometry.clear();
    this.updateScreenGeometryFrom(hierarchy);
    if (captureSequence !== null) {
      this.host.screenGeometry.markForwarded(captureSequence);
    }
    this.host.startScreenshotBackoff();
  }

  /**
   * Push screenshot update to the device data stream for IDE plugins.
   */
  pushScreenshotToObservationStream({
    screenshotBase64,
    screenWidth,
    screenHeight,
    metadata = IOS_CTRLPROXY_SCREENSHOT_METADATA,
    captureSequence,
    coordinateSpace,
    nativeScale,
    frameContext,
    rotation,
  }: ScreenshotObservationStreamOptions): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    try {
      // Identity, coordinate space, and native scale travel with the frame from request initiation,
      // never from the latest metadata at delivery time. A hierarchy that flips scale metadata
      // while pixels are in flight must not relabel their geometry or their swipe threshold.
      server.pushScreenshotUpdate(this.host.deviceId, screenshotBase64, {
        screenWidth,
        screenHeight,
        metadata,
        options: {
          captureSequence,
          ...(coordinateSpace ? { coordinateSpace } : {}),
          ...(nativeScale === undefined ? {} : { nativeScale }),
          frameContext,
          rotation,
        },
      });
    } catch (error) {
      logger.debug(
        `[IOSCtrlProxyClient] Failed to push screenshot to observation stream: ${error}`,
      );
    }
  }

  // ===========================================================================
  // Screenshot Backoff for Real-time Streaming
  // ===========================================================================

  /**
   * Start screenshot backoff sequence for real-time screenshot streaming to IDE.
   * Called when a hierarchy push update is received to capture corresponding screenshots.
   */
  startScreenshotBackoff(): void {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.host.deviceId)) {
      return;
    }

    const scheduler = this.getScreenshotBackoffScheduler();
    scheduler.startBackoffSequence();
  }

  private getScreenshotBackoffScheduler(): ScreenshotBackoffScheduler {
    return this.host.createScreenshotBackoffScheduler(
      async () => this.host.captureScreenshotForBackoff(),
      (result) => this.emitBackoffScreenshot(result),
    );
  }

  private emitBackoffScreenshot(result: ScreenshotCaptureResult): void {
    if (!result.data) {
      return;
    }
    // Get screen dimensions from cached hierarchy or use defaults. A fallback has no capture
    // provenance at all, so it must never be asserted as tracked.
    // Declare the geometry the request was BOUND to, not whatever the cache holds now.
    // Without a binding, fall back to a nominal size and send no identity, so a control
    // client fails closed.
    const binding = result.captureBinding;
    const screenWidth = binding?.width ?? this.host.screenGeometry.width ?? 1170;
    const screenHeight = binding?.height ?? this.host.screenGeometry.height ?? 2532;
    this.pushScreenshotToObservationStream({
      screenshotBase64: result.data,
      screenWidth,
      screenHeight,
      metadata: result,
      captureSequence: binding?.captureSequence,
      coordinateSpace: binding?.coordinateSpace,
      nativeScale: binding?.nativeScale,
      frameContext: result.frameContext,
      rotation: result.rotation,
    });
  }

  async captureScreenshotForBackoff(): Promise<ScreenshotCaptureResult> {
    const server = getDeviceDataStreamServer();
    if (!server || !server.hasSubscriberForDevice(this.host.deviceId)) {
      return { success: false, error: "No subscribers" };
    }

    // Bind the capture identity current at INITIATION and carry it through the await, so a
    // hierarchy forwarded while this frame is in flight cannot relabel it. Same-resolution
    // navigation makes this the only defence — the pixels are identical in size either way.
    const captureBinding = this.host.screenGeometry.bind() ?? undefined;

    try {
      const result = await this.host.requestScreenshot(5000);
      if (!result.success || !result.data) {
        return { success: false, error: result.error || "No screenshot data" };
      }

      return {
        success: true,
        data: result.data,
        captureBinding,
        frameContext: result.frameContext,
        rotation: result.rotation,
        ...metadataForScreenshotFormat(IOS_CTRLPROXY_SCREENSHOT_METADATA, result.format),
      };
    } catch (error) {
      logger.warn(
        `[IOSCtrlProxyClient] Screenshot backoff capture failed: ${errorMessage(error)}`,
        error,
      );
      return { success: false, error: `${error}` };
    }
  }

  /**
   * Record the screen geometry described by [source] — the hierarchy about to be forwarded, never
   * whatever happens to be cached (issue #3348).
   */
  private updateScreenGeometryFrom(
    source:
      | {
          screenWidth?: number;
          screenHeight?: number;
          screenScale?: number;
          nativeScale?: number;
          pixelWidth?: number;
          pixelHeight?: number;
        }
      | null
      | undefined,
  ): void {
    const hierarchy = source;
    if (!hierarchy?.screenWidth || !hierarchy.screenHeight) {
      // No usable geometry in this hierarchy. Clearing (rather than keeping the previous entry)
      // stops a later push from vouching for dimensions this hierarchy cannot confirm.
      this.host.screenGeometry.clear();
      return;
    }
    // Canonical pixels (#4549): the capture-identity claim must equal the screenshot's real pixels,
    // which XCUIScreenshot renders at NATIVE scale. When the runner supplied complete scale
    // metadata, use its reported pixelWidth/pixelHeight (derived at nativeScale in #4548) directly —
    // NOT points * screenScale, which diverges from the PNG under Display Zoom. A pre-#4548 runner
    // has no metadata, so fall back to the legacy points * screenScale claim, byte-identical.
    const metadata = readScreenScaleMetadata(hierarchy);
    const [pixelWidth, pixelHeight] = metadata
      ? [metadata.pixelWidth, metadata.pixelHeight]
      : [
          Math.round(hierarchy.screenWidth * (hierarchy.screenScale ?? 1)),
          Math.round(hierarchy.screenHeight * (hierarchy.screenScale ?? 1)),
        ];
    // A change clears the forwarded flag: the geometry becomes capture-tracked only once a
    // hierarchy carrying it is forwarded (see pushHierarchyToObservationStream) — which will NOT
    // happen while hierarchy pushes are suppressed, or when there is no stream server. The
    // Coordinate space and native scale are bound here from THIS hierarchy, so a later metadata
    // flip cannot restamp a frame whose request was bound now.
    this.host.screenGeometry.update(
      pixelWidth,
      pixelHeight,
      metadata ? COORDINATE_SPACE_PX : undefined,
      metadata?.nativeScale,
    );
  }
}
