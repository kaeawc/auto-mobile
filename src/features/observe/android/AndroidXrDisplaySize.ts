import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../models";
import {
  isAndroidXr,
  type AndroidXrDetector,
} from "../../../utils/android-cmdline-tools/androidXrDevice";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage as describeError } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { HierarchyCollectorPort } from "../collectors/collectorPorts";

export interface AndroidXrDisplaySize {
  prime(
    result: Pick<ObserveResult, "backStack">,
    hierarchy: ViewHierarchyResult,
    signal?: AbortSignal,
    displayId?: number,
  ): Promise<void>;
  applyCached(
    result: Pick<ObserveResult, "screenSize">,
    hierarchy: ViewHierarchyResult,
    displayId?: number,
  ): void;
}

export interface AndroidXrDisplaySizeDeps {
  device: () => BootedDevice;
  hierarchyCollector: () => Pick<HierarchyCollectorPort, "reconcileScreenDimensions">;
  adb?: () => AdbExecutor | null;
  xrDetector?: AndroidXrDetector;
  logger?: Pick<typeof logger, "warn">;
  readDisplaySize?: () => Promise<{ width: number; height: number }>;
}

/** Default-display XR geometry shared by initial collection and synchronous recapture application. */
export class CachedAndroidXrDisplaySize implements AndroidXrDisplaySize {
  private readonly displaySizes = new Map<string, { width: number; height: number }>();

  constructor(private readonly deps: AndroidXrDisplaySizeDeps) {}

  private key(hierarchy: ViewHierarchyResult): string {
    return `${this.deps.device().deviceId}:${Number(hierarchy.rotation === 1 || hierarchy.rotation === 3)}`;
  }

  async prime(
    result: Pick<ObserveResult, "backStack">,
    hierarchy: ViewHierarchyResult,
    signal?: AbortSignal,
    displayId = hierarchy.displayId ?? 0,
  ): Promise<void> {
    const device = this.deps.device();
    if (device.platform !== "android" || displayId !== 0 || !this.deps.readDisplaySize) {
      return;
    }
    const key = this.key(hierarchy);
    // A primed entry already established XR identity; action refreshes may lack back-stack evidence.
    if (this.displaySizes.has(key)) {
      return;
    }
    if (!(await this.isXr(result, signal))) {
      return;
    }
    try {
      const physical = await this.deps.readDisplaySize();
      const rotated = hierarchy.rotation === 1 || hierarchy.rotation === 3;
      this.displaySizes.set(
        key,
        rotated ? { width: physical.height, height: physical.width } : physical,
      );
    } catch (error) {
      (this.deps.logger ?? logger).warn(
        `[OBSERVE] XR display size read failed; using hierarchy size: ${describeError(error)}`,
        error,
      );
    }
  }

  private isXr(result: Pick<ObserveResult, "backStack">, signal?: AbortSignal): Promise<boolean> {
    const device = this.deps.device();
    const xrFormFactor = device.formFactor === "xr-headset" || device.formFactor === "xr-glasses";
    return isAndroidXr(
      {
        device,
        adb: xrFormFactor ? this.deps.adb?.() : undefined,
        backStack: result.backStack,
        signal,
      },
      this.deps.xrDetector,
    );
  }

  applyCached(
    result: Pick<ObserveResult, "screenSize">,
    hierarchy: ViewHierarchyResult,
    displayId = hierarchy.displayId ?? 0,
  ): void {
    if (this.deps.device().platform !== "android" || displayId !== 0) {
      return;
    }
    const size = this.displaySizes.get(this.key(hierarchy));
    if (size) {
      result.screenSize = { ...size };
      this.deps.hierarchyCollector().reconcileScreenDimensions(hierarchy, size);
      hierarchy.pixelWidth = size.width;
      hierarchy.pixelHeight = size.height;
    }
  }
}
