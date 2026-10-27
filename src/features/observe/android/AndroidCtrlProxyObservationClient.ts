import { ScreenScaleMetadata, ViewHierarchyResult } from "../../../models";
import { serverConfig } from "../../../utils/ServerConfig";
import { logger } from "../../../utils/logger";
import { HierarchyNavigationDetector } from "../../navigation/HierarchyNavigationDetector";
import { NavigationScreenshotManager } from "../../navigation/NavigationScreenshotManager";
import { ScreenshotBackoffScheduler, ScreenshotCaptureResult } from "../ScreenshotBackoffScheduler";
import {
  ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
  type ScreenshotMetadata,
} from "../ScreenshotMetadata";
import { type ScreenGeometryBinding } from "../TrackedScreenGeometry";
import { AndroidCtrlProxyServices } from "./AndroidCtrlProxyServices";
import { AndroidObservationStream } from "./AndroidObservationStream";
import {
  ANDROID_CAPABILITY_GATED_COMMANDS,
  ANDROID_FULL_COMMAND_SET_CAPABILITY,
  MULTI_FINGER_GESTURE_CAPABILITY,
  PROTOTYPE_DISPLAY_CAPABILITY,
  PROTOTYPE_MULTI_SURFACE_CAPABILITY,
  PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY,
  PROTOTYPE_STORAGE_CAPABILITY,
  PROTOTYPE_WINDOW_OPTIONS_CAPABILITY,
} from "./ctrlProxyProtocol";
import type { AccessibilityHierarchy } from "./types";
export abstract class AndroidCtrlProxyObservationClient extends AndroidCtrlProxyServices {
  private observationStream: AndroidObservationStream | undefined;

  private getObservationStream(): AndroidObservationStream {
    const client = this;
    return (this.observationStream ??= new AndroidObservationStream({
      get device() {
        return client.device;
      },
      get hierarchy() {
        return client.hierarchy;
      },
      screenGeometry: client.screenGeometry,
      isCommandSupported: (messageType) => client.isCommandSupported(messageType),
      sendMessage: (message) => client.sendMessage(message),
      captureScreenshotForObservationStream: () => client.captureScreenshotForObservationStream(),
      startScreenshotBackoff: () => client.startScreenshotBackoff(),
      pushScreenshotToObservationStream: (...args) =>
        client.pushScreenshotToObservationStream(...args),
      createScreenshotBackoffScheduler: (...args) =>
        client.createScreenshotBackoffScheduler(...args),
      forwardHierarchyToObservationStream: (...args) =>
        client.forwardHierarchyToObservationStream(...args),
    }));
  }

  convertToViewHierarchyResult(
    accessibilityHierarchy: AccessibilityHierarchy,
  ): ViewHierarchyResult {
    return this.getObservationStream().convertToViewHierarchyResult(accessibilityHierarchy);
  }

  // ===========================================================================
  // Hierarchy Navigation Detector
  // ===========================================================================

  getHierarchyNavigationDetector(): HierarchyNavigationDetector {
    if (!this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector = new HierarchyNavigationDetector(
        this.getNavigationGraphManager(),
        { timer: this.timer },
      );

      this.hierarchyNavigationDetector.setNavigationCallback((info) => {
        if (info.packageName && info.screenFingerprint) {
          if (!serverConfig.isNavigationScreenshotsEnabled()) {
            return;
          }
          const appId = info.packageName;
          const screenName = `screen_${info.screenFingerprint.substring(0, 12)}`;
          NavigationScreenshotManager.getInstance()
            .captureAndStore(this.device, this.adb, appId, screenName)
            .then((screenshotPath) => {
              if (screenshotPath) {
                this.getNavigationGraphManager()
                  .updateNodeScreenshot(appId, screenName, screenshotPath)
                  .catch((err) =>
                    logger.warn(`[CTRL_PROXY] Failed to update hierarchy screenshot: ${err}`),
                  );
              }
            })
            .catch((err) =>
              logger.debug(`[CTRL_PROXY] Hierarchy screenshot capture skipped: ${err}`),
            );
        }
      });
    }
    return this.hierarchyNavigationDetector;
  }

  resetHierarchyNavigationDetector(): void {
    if (this.hierarchyNavigationDetector) {
      this.hierarchyNavigationDetector.reset();
    }
  }

  // ===========================================================================
  // Screenshot Backoff
  // ===========================================================================

  cancelScreenshotBackoff(): void {
    if (this.screenshotBackoffScheduler) {
      // Fully quiesce (including the trailing throttle capture) — this is a teardown/quiesce path
      // (disconnect, pre-action), not a sequence restart, so nothing should survive (issue #4927).
      this.screenshotBackoffScheduler.stop();
    }
  }

  refreshObservationStreamScreenshotCadence(): void {
    this.screenshotBackoffScheduler?.rescheduleKeepAlive();
  }

  refreshObservationStreamHierarchyCadence(intervalMs?: number | null): void {
    return this.getObservationStream().refreshObservationStreamHierarchyCadence(intervalMs);
  }

  protected pushHierarchyToObservationStream(
    wireHierarchy: AccessibilityHierarchy,
    frameContext?: string,
  ): void {
    return this.getObservationStream().pushHierarchyToObservationStream(
      wireHierarchy,
      frameContext,
    );
  }

  recordInitialObservationStreamHierarchy(
    hierarchy: ViewHierarchyResult,
    captureSequence: number | null,
  ): void {
    return this.getObservationStream().recordInitialObservationStreamHierarchy(
      hierarchy,
      captureSequence,
    );
  }

  pushScreenshotToObservationStream(
    screenshotBase64: string,
    metadata: ScreenshotMetadata = ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
    binding?: ScreenGeometryBinding,
    frameContext?: string,
    rotation?: number,
  ): void {
    return this.getObservationStream().pushScreenshotToObservationStream(
      screenshotBase64,
      metadata,
      binding,
      frameContext,
      rotation,
    );
  }

  protected updateCachedScreenDimensions(
    hierarchy: Pick<
      AccessibilityHierarchy,
      "windows" | "nativeScale" | "pixelWidth" | "pixelHeight"
    >,
  ): void {
    return this.getObservationStream().updateCachedScreenDimensions(hierarchy);
  }

  getScreenScaleMetadata(): ScreenScaleMetadata | null {
    return this.getObservationStream().getScreenScaleMetadata();
  }

  protected getScreenshotBackoffScheduler(): ScreenshotBackoffScheduler {
    return this.getObservationStream().getScreenshotBackoffScheduler();
  }

  async captureScreenshotForObservationStream(): Promise<ScreenshotCaptureResult> {
    return this.getScreenshotCapture().captureForObservationStream();
  }

  startScreenshotBackoff(): void {
    return this.getObservationStream().startScreenshotBackoff();
  }

  protected isCommandSupported(messageType: string): boolean {
    if (this.rejectedCommands.has(messageType)) {
      return false;
    }
    if (this.supportedCommands?.has(ANDROID_FULL_COMMAND_SET_CAPABILITY)) {
      return this.supportedCommands.has(messageType);
    }
    // Legacy behavior for services that predate full_command_set_v1 (older APKs).
    if (
      [
        "gesture_display_id_v1",
        "tap_double_v1",
        MULTI_FINGER_GESTURE_CAPABILITY,
        PROTOTYPE_DISPLAY_CAPABILITY,
        PROTOTYPE_WINDOW_OPTIONS_CAPABILITY,
        PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY,
        PROTOTYPE_MULTI_SURFACE_CAPABILITY,
        PROTOTYPE_STORAGE_CAPABILITY,
      ].includes(messageType)
    ) {
      return this.supportedCommands?.has(messageType) === true;
    }
    if (this.supportedCommands === null) {
      return true;
    }
    if (ANDROID_CAPABILITY_GATED_COMMANDS.has(messageType)) {
      return this.supportedCommands.has(messageType);
    }
    return true;
  }
}
