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
  /**
   * Like prime, but re-reads `wm size` even when this rotation parity is cached, so an override
   * set mid-instance (displayConfig or raw adb) reaches the next observe (#17915). A known XR
   * verdict stays cached.
   */
  refresh(
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

/**
 * Whether the feature probe is worth asking: an XR form factor, or one not yet classified (a
 * physical headset, #17908). A known phone, tablet or other form factor is never probed.
 */
function mayBeXrFormFactor(formFactor: BootedDevice["formFactor"]): boolean {
  return (
    formFactor === undefined ||
    formFactor === "unknown" ||
    formFactor === "xr-headset" ||
    formFactor === "xr-glasses"
  );
}

/** Default-display XR geometry shared by initial collection and synchronous recapture application. */
export class CachedAndroidXrDisplaySize implements AndroidXrDisplaySize {
  private readonly displaySizes = new Map<string, { width: number; height: number }>();
  private readonly xrDevices = new Map<string, boolean>();

  constructor(private readonly deps: AndroidXrDisplaySizeDeps) {}

  /** The identity resolved by prime; element enrichment must not probe or yield again. */
  isXrCached(): boolean {
    const device = this.deps.device();
    return device.platform === "android" && this.xrDevices.get(device.deviceId) === true;
  }

  private key(hierarchy: ViewHierarchyResult): string {
    return `${this.deps.device().deviceId}:${Number(hierarchy.rotation === 1 || hierarchy.rotation === 3)}`;
  }

  prime(
    result: Pick<ObserveResult, "backStack">,
    hierarchy: ViewHierarchyResult,
    signal?: AbortSignal,
    displayId = hierarchy.displayId ?? 0,
  ): Promise<void> {
    return this.primeSize({ result, hierarchy, signal, displayId, reread: false });
  }

  refresh(
    result: Pick<ObserveResult, "backStack">,
    hierarchy: ViewHierarchyResult,
    signal?: AbortSignal,
    displayId = hierarchy.displayId ?? 0,
  ): Promise<void> {
    return this.primeSize({ result, hierarchy, signal, displayId, reread: true });
  }

  private async primeSize(request: {
    result: Pick<ObserveResult, "backStack">;
    hierarchy: ViewHierarchyResult;
    signal?: AbortSignal;
    displayId: number;
    reread: boolean;
  }): Promise<void> {
    const device = this.deps.device();
    if (device.platform !== "android" || request.displayId !== 0 || !this.deps.readDisplaySize) {
      return;
    }
    // A primed entry already established XR identity; action refreshes may lack back-stack evidence.
    const primed = this.displaySizes.has(this.key(request.hierarchy));
    if (primed && !request.reread) {
      return;
    }
    const xr = primed || (await this.isXr(request.result, request.signal));
    this.xrDevices.set(device.deviceId, xr);
    if (xr) {
      await this.readSize(this.deps.readDisplaySize, request.hierarchy);
    }
  }

  private async readSize(
    readDisplaySize: () => Promise<{ width: number; height: number }>,
    hierarchy: ViewHierarchyResult,
  ): Promise<void> {
    try {
      const physical = await readDisplaySize();
      const rotated = hierarchy.rotation === 1 || hierarchy.rotation === 3;
      // A fresh read supersedes the other rotation parity too; it re-reads on its next prime.
      this.displaySizes.delete(`${this.deps.device().deviceId}:${Number(!rotated)}`);
      this.displaySizes.set(
        this.key(hierarchy),
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
    return isAndroidXr(
      {
        device,
        adb: mayBeXrFormFactor(device.formFactor) ? this.deps.adb?.() : undefined,
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
