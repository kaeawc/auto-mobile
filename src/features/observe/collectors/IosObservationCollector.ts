import type {
  DevicectlDisplayInfo,
  DevicectlDisplayInfoSource,
} from "../../../utils/ios-cmdline-tools/DevicectlDisplayInfo";
import type { DisplayPanel } from "../../../models/DisplayPanel";
import { sizeMatchesPanel } from "../../device/postureCommands";
import { liveIosPanelFor, rememberLiveIosPanel } from "../ObservationDisplay";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { BootedDevice, ObserveResult, ScreenIdentity } from "../../../models";
import type { ViewHierarchy as ViewHierarchyInterface } from "../interfaces/ViewHierarchy";
import { inheritHierarchySnapshot } from "../HierarchyCapture";
import { projectActionableHierarchy } from "../HierarchyNormalization";
import { resolveIosObserveRotation } from "../iosObserveRotation";
import { deriveIosScreenIdentity } from "../ios/IosScreenIdentity";
import type { PlatformCollectionContext } from "./AndroidObservationCollector";
import type { HierarchyCollectorPort } from "./collectorPorts";
import {
  deviceIosSdkBridgeReader,
  mergeIosSdkBridgeInto,
  type IosSdkBridgeReader,
} from "../ios/IosSdkBridgeReader";
import {
  deviceIosSdkWebReader,
  mergeIosSdkWebInto,
  type IosSdkWebReader,
} from "../ios/IosSdkWebReader";

/** Platform-specific hierarchy collection and metadata derivation for iOS observations. */
export interface IosObservationCollector {
  collect(context: PlatformCollectionContext): Promise<void>;
}

export interface IosObservationCollectorDeps {
  hierarchyCollector: () => HierarchyCollectorPort;
  viewHierarchy: () => ViewHierarchyInterface;
  device: () => BootedDevice;
  iosDisplayInfoSource?: DevicectlDisplayInfoSource;
  /** The app's SDK observation bridge (#5159); defaults to the device's runner client. */
  sdkBridge?: () => IosSdkBridgeReader;
  /** The app's opted-in WKWebView bridges (#5162); defaults to the device's runner client. */
  sdkWeb?: () => IosSdkWebReader;
}

function activeLivePanel(
  displays: DevicectlDisplayInfo[],
  panels: DisplayPanel[],
): DisplayPanel | undefined {
  const active = displays.filter((display) => display.active === true);
  const size = active.length === 1 ? (active[0].nativeSize ?? active[0].bounds?.size) : undefined;
  const matches = size ? panels.filter((panel) => sizeMatchesPanel(size, panel)) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

export class DefaultIosObservationCollector implements IosObservationCollector {
  constructor(private readonly deps: IosObservationCollectorDeps) {}

  async collect({
    result,
    queryOptions,
    perf,
    skipWaitForFresh,
    minTimestamp,
    signal,
    readOnly,
    capturedHierarchy,
    readOptions,
  }: PlatformCollectionContext): Promise<void> {
    perf.serial("ios_collect");
    await this.deps.hierarchyCollector().collect(result, {
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
      readOnly,
      capturedHierarchy,
      readOptions,
    });

    rememberLiveIosPanel(result, await this.readLiveIosPanel(signal));
    this.applyIosScreenMetadata(result);
    this.applyLiveIosPanelSize(result);
    this.applyIosInsetsAndRotation(result);
    this.projectIosObservationHierarchy(result);
    await this.mergeSdkBridgeObservation(result, signal);
    await this.mergeSdkWebSnapshots(result, signal);

    let sdkScreenIdentity: ScreenIdentity | undefined;
    try {
      sdkScreenIdentity = await this.deps
        .viewHierarchy()
        .getScreenIdentity?.(result.viewHierarchy?.packageName, result.viewHierarchy?.updatedAt);
    } catch (error) {
      // The hierarchy remains valid when the optional SDK refresh fails.
      logger.debug(`[iOS] SDK screen identity refresh failed; using hierarchy identity: ${error}`);
    }
    const hierarchyScreenIdentity = deriveIosScreenIdentity(
      result.viewHierarchy,
      result.screenSize,
    );
    result.screenIdentity = hierarchyScreenIdentity?.components.modalClass
      ? hierarchyScreenIdentity
      : (sdkScreenIdentity ?? hierarchyScreenIdentity);

    perf.end();
  }

  /**
   * Merge a registered SDK observation bridge's nodes under the app node (#5159). An app without a
   * bridge, or with routing disabled, observes exactly as before.
   */
  private async mergeSdkBridgeObservation(
    result: ObserveResult,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!result.viewHierarchy) {
      return;
    }
    const reader = this.deps.sdkBridge?.() ?? deviceIosSdkBridgeReader(this.deps.device());
    const merged = await mergeIosSdkBridgeInto(result.viewHierarchy, reader, signal);
    if (merged.backend) {
      result.backend = merged.backend;
    }
    if (merged.fallbackReason) {
      result.fallbackReason = merged.fallbackReason;
    }
  }

  /**
   * Merge opted-in web views' allowed-origin DOM elements under their WKWebView nodes (#5162). A
   * screen without a web view, or an app that registered none, observes exactly as before.
   */
  private async mergeSdkWebSnapshots(
    result: ObserveResult,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!result.viewHierarchy) {
      return;
    }
    const reader = this.deps.sdkWeb?.() ?? deviceIosSdkWebReader(this.deps.device());
    const merged = await mergeIosSdkWebInto(result.viewHierarchy, reader, signal);
    if (merged && !result.backend) {
      result.backend = "sdk";
    }
  }

  /** Read this observation's live panel; the caller keeps it on this observation only. */
  private async readLiveIosPanel(signal?: AbortSignal): Promise<DisplayPanel | undefined> {
    const device = this.deps.device();
    const panels = device.displays?.panels ?? [];
    if (panels.length < 2) {
      return undefined;
    }
    if (!this.deps.iosDisplayInfoSource) {
      logger.debug("[iOS] Live panel source unavailable; using runner size");
      return undefined;
    }
    try {
      const displays = await this.deps.iosDisplayInfoSource.readDisplays({
        deviceId: device.deviceId,
        signal,
      });
      signal?.throwIfAborted();
      const panel = activeLivePanel(displays, panels);
      if (!panel) {
        logger.debug("[iOS] No unique active CoreDevice panel; using runner size");
      }
      return panel;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`[iOS] Live panel read failed; using runner size: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  private applyLiveIosPanelSize(result: ObserveResult): void {
    const panel = liveIosPanelFor(result);
    if (!panel?.scale || panel.scale <= 0) {
      return;
    }
    const width = panel.sizePx.width / panel.scale;
    const height = panel.sizePx.height / panel.scale;
    const runner = result.screenSize;
    if (
      (runner.width === width && runner.height === height) ||
      (runner.width === height && runner.height === width)
    ) {
      return;
    }
    const landscape = result.viewHierarchy?.rotation === 1 || result.viewHierarchy?.rotation === 3;
    result.screenSize = landscape ? { width: height, height: width } : { width, height };
  }

  private applyIosScreenMetadata(result: ObserveResult): void {
    // Resolve screen size: hierarchy-derived bounds, then CtrlProxy-reported logical points.
    const extractedSize = this.deps
      .hierarchyCollector()
      .extractScreenSize(
        result.viewHierarchy,
        (this.deps.device().displays?.panels.length ?? 0) > 1,
      );
    if (extractedSize) {
      result.screenSize = extractedSize;
      logger.debug(
        `[iOS] Extracted screen size from hierarchy: ${extractedSize.width}x${extractedSize.height}`,
      );
    } else if (result.viewHierarchy?.screenWidth && result.viewHierarchy?.screenHeight) {
      result.screenSize = {
        width: result.viewHierarchy.screenWidth,
        height: result.viewHierarchy.screenHeight,
      };
      logger.debug(
        `[iOS] Using screen size from CtrlProxy iOS: ${result.screenSize.width}x${result.screenSize.height}`,
      );
    } else {
      logger.warn("[iOS] Failed to extract screen size from hierarchy");
    }
  }

  private applyIosInsetsAndRotation(result: ObserveResult): void {
    if (result.viewHierarchy?.insets) {
      result.insets = result.viewHierarchy.insets;
    }
    if (result.viewHierarchy?.systemInsets) {
      result.systemInsets = result.viewHierarchy.systemInsets;
    }
    result.rotation = resolveIosObserveRotation(result.viewHierarchy?.rotation, result.screenSize);
  }

  private projectIosObservationHierarchy(result: ObserveResult): void {
    // Use the same iOS visibility projection as action and diagnostic captures.
    if (result.viewHierarchy && result.screenSize?.width > 0 && result.screenSize?.height > 0) {
      // Reconcile the duplicated viewHierarchy.screenWidth/screenHeight fields
      // with the authoritative screenSize before filtering (which preserves
      // them). The iOS runner can report a stale 320x480 (legacy compatibility
      // mode) value; keep the hierarchy fields consistent for consumers that
      // read them directly (issue #2683).
      this.deps
        .hierarchyCollector()
        .reconcileScreenDimensions(result.viewHierarchy, result.screenSize);

      const rawHierarchy = result.viewHierarchy;
      const iosMultiPanel = (this.deps.device().displays?.panels.length ?? 0) > 1;
      result.viewHierarchy = projectActionableHierarchy("ios", rawHierarchy, iosMultiPanel);
      inheritHierarchySnapshot(rawHierarchy, result.viewHierarchy, iosMultiPanel);
    }

    // Populate activeWindow from view hierarchy packageName if not already set.
    if (result.viewHierarchy?.packageName && !result.activeWindow) {
      result.activeWindow = {
        appId: result.viewHierarchy.packageName,
        activityName: "",
        layoutSeqSum: 0,
      };
    }
  }
}
