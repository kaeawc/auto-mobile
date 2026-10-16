import { logger } from "../../../utils/logger";
import type { BootedDevice, ObserveResult, ScreenIdentity } from "../../../models";
import type { ViewHierarchy as ViewHierarchyInterface } from "../interfaces/ViewHierarchy";
import { inheritHierarchySnapshot } from "../HierarchyCapture";
import { projectActionableHierarchy } from "../HierarchyNormalization";
import { resolveIosObserveRotation } from "../iosObserveRotation";
import { deriveIosScreenIdentity } from "../ios/IosScreenIdentity";
import type { PlatformCollectionContext } from "./AndroidObservationCollector";
import type { HierarchyCollector } from "./HierarchyCollector";

/** Platform-specific hierarchy collection and metadata derivation for iOS observations. */
export interface IosObservationCollector {
  collect(context: PlatformCollectionContext): Promise<void>;
}

export interface IosObservationCollectorDeps {
  hierarchyCollector: () => HierarchyCollector;
  viewHierarchy: () => ViewHierarchyInterface;
  device: () => BootedDevice;
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
    await this.deps
      .hierarchyCollector()
      .collect(
        result,
        queryOptions,
        perf,
        skipWaitForFresh,
        minTimestamp,
        signal,
        readOnly,
        capturedHierarchy,
        readOptions,
      );

    this.applyIosScreenMetadata(result);
    this.applyIosInsetsAndRotation(result);
    this.projectIosObservationHierarchy(result);

    let sdkScreenIdentity: ScreenIdentity | undefined;
    try {
      sdkScreenIdentity = await this.deps
        .viewHierarchy()
        .getScreenIdentity?.(result.viewHierarchy?.packageName);
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
