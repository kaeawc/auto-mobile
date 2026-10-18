import type { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { logger } from "../../utils/logger";
import { serverConfig } from "../../utils/ServerConfig";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import type { AndroidCtrlProxyClient } from "../observe/android";
import { getHierarchySnapshot, type HierarchyCapture } from "../observe/HierarchyCapture";
import type { DisplayTransitionTracker } from "../observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import { StaleDisplayError } from "../observe/StaleDisplayError";
import type { ViewHierarchy } from "../observe/ViewHierarchy";
import { isUsableScreenSize } from "../utility/ElementGeometry";
import { ElementResolver } from "../utility/ElementResolver";
import { SearchableHierarchy } from "../utility/SearchableNode";
import {
  resolveAndroidStableTapTarget,
  type StableTapTargetResult,
} from "./androidStableTapTarget";
import { readFreshPlatformHierarchy } from "./tapHierarchyRead";
import type { TapPointPlanner } from "./tapPointPlanner";
import type { AndroidTapVerification, TapVerificationOptions } from "./tapVerificationOptions";

/** What the hierarchy refresh phase needs from the owning tap action. */
export interface TapHierarchyRefreshHost {
  readonly device: BootedDevice;
  readonly timer: Timer;
  /** Whether the platform strategy re-verifies the display identity after a refresh. */
  verifiesRefreshedDisplay(): boolean;
  adb(): AdbExecutor;
  accessibilityService(): AndroidCtrlProxyClient;
  viewHierarchy(): ViewHierarchy;
  hierarchyCapture(): HierarchyCapture;
  elementParser(): ElementParser;
  refreshedDisplayTransitions(): Pick<DisplayTransitionTracker, "checkIdentity" | "record">;
  displayTransitionIdentityRevision(deviceId: string): number;
  renderedDisplayGeneration(deviceId: string): number | undefined;
  staleDisplay(generation: number): StaleDisplayError;
  getScreenSizeFromHierarchy: TapPointPlanner["getScreenSizeFromHierarchy"];
  prepareViewHierarchyForResponse(
    raw: ViewHierarchyResult,
    screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult;
  /** Routed through the owner so overriding it observes the phase's own refreshes. */
  refreshViewHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture?: boolean,
  ): Promise<ViewHierarchyResult | null>;
  /** Routed through the owner so overriding it observes the stability loop. */
  staleSyntheticTarget(
    original: Element | null,
    previous: ViewHierarchyResult | undefined,
    current: ViewHierarchyResult,
  ): string | undefined;
  findElementInHierarchy: Parameters<
    typeof resolveAndroidStableTapTarget
  >[0]["findElementInHierarchy"];
  resolveTapTargetElement: Parameters<
    typeof resolveAndroidStableTapTarget
  >[0]["resolveTapTargetElement"];
  withObservationScreenSize(
    options: TapVerificationOptions,
    observation: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
  ): TapVerificationOptions;
}

/**
 * Fresh hierarchy reads for tapOn: the fresh capture with display-identity
 * checks, the platform hierarchy read, and the Android pre-tap stable-target
 * re-find loop.
 */
export class TapHierarchyRefreshPhase {
  constructor(private readonly host: TapHierarchyRefreshHost) {}

  async refreshViewHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    throwIfAborted(signal);
    if (timeoutMs <= 0) {
      return null;
    }
    const observedGeneration =
      this.host.renderedDisplayGeneration(this.host.device.deviceId) ??
      this.host.displayTransitionIdentityRevision(this.host.device.deviceId);
    let captured: ViewHierarchyResult;
    try {
      captured = (
        await this.host.hierarchyCapture().capture({
          freshness: "fresh",
          ...(forceCapture ? { requireFreshExtraction: true } : {}),
          searchRaw: serverConfig.isRawElementSearchEnabled(),
          timeoutMs,
          signal,
        })
      ).hierarchy;
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        throw error;
      }
      throwIfAborted(signal);
      logger.warn(`[TapOnElement] Fresh capture failed: ${errorMessage(error)}`);
      return null;
    }
    if (isUsableScreenSize(screenSize) && this.host.verifiesRefreshedDisplay()) {
      await this.checkRefreshedDisplay(captured, screenSize, observedGeneration, signal);
    }
    return captured;
  }

  tapVerificationRefresh(context: {
    refresh?: AndroidTapVerification["refresh"];
    screenSize?: ObserveResult["screenSize"];
    signal?: AbortSignal;
  }): AndroidTapVerification["refresh"] {
    return (
      context.refresh ??
      ((timeoutMs) => this.host.refreshViewHierarchy(timeoutMs, context.screenSize, context.signal))
    );
  }

  private async checkRefreshedDisplay(
    captured: ViewHierarchyResult,
    screenSize: ObserveResult["screenSize"],
    observedGeneration: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const freshSize = this.host.getScreenSizeFromHierarchy(captured);
    if (
      !freshSize ||
      (freshSize.width === screenSize.width &&
        freshSize.height === screenSize.height &&
        (this.host.device.displays?.panels.length ?? 0) < 2)
    ) {
      return;
    }
    const display = await this.refreshedDisplay(captured, signal);
    const identityChanged = this.host
      .refreshedDisplayTransitions()
      .checkIdentity(this.host.device.deviceId, display);
    const geometryTransition = this.host
      .refreshedDisplayTransitions()
      .record(this.host.device.deviceId, {
        display,
        screenSize: freshSize,
      });
    if (identityChanged || geometryTransition) {
      throw this.host.staleDisplay(observedGeneration);
    }
  }

  private async refreshedDisplay(
    captured: ViewHierarchyResult,
    signal?: AbortSignal,
  ): Promise<ObserveResult["display"]> {
    const displayCache = new ObservedAndroidDisplayCache(this.host.timer);
    const focusedPanel = await displayCache.panelForLogicalId(
      this.host.device,
      this.host.adb(),
      captured.displayId,
      signal,
      { panelUniqueId: captured.panelUniqueId, panelFingerprint: captured.panelFingerprint },
      false,
    );
    const resolved = await displayCache.resolve(this.host.device, this.host.adb(), signal);
    const panel =
      focusedPanel ??
      this.host.device.displays?.panels.find((candidate) => candidate.key === resolved.display.key);
    return {
      ...resolved.display,
      key: panel?.key ?? resolved.display.key,
      role: panel?.role ?? resolved.display.role,
      posture: await displayCache.posture(this.host.device, this.host.adb(), signal),
    };
  }

  async readFreshHierarchy(
    timeoutMs: number,
    screenSize?: ObserveResult["screenSize"],
    signal?: AbortSignal,
    forceCapture: boolean = false,
  ): Promise<ViewHierarchyResult | null> {
    throwIfAborted(signal);
    const effectiveTimeoutMs = Math.max(0, timeoutMs);
    if (effectiveTimeoutMs === 0) {
      return null;
    }
    return readFreshPlatformHierarchy(
      {
        device: this.host.device,
        adb: this.host.adb(),
        timer: this.host.timer,
        androidService: this.host.accessibilityService(),
        viewHierarchy: this.host.viewHierarchy(),
        prepareForResponse: (raw, size) => this.host.prepareViewHierarchyForResponse(raw, size),
        actionLabel: "tap on elements",
      },
      { timeoutMs: effectiveTimeoutMs, screenSize, signal, forceCapture },
    );
  }

  /**
   * Re-fetch the Android hierarchy and re-resolve the tap target until bounds match on enough
   * consecutive re-finds; see {@link resolveAndroidStableTapTarget}.
   */
  resolveAndroidStableTapTargetAfterRefreshes(
    options: TapVerificationOptions,
    observeResult: Partial<Pick<ObserveResult, "viewHierarchy" | "screenSize">>,
    action: TapOnElementOptions["action"],
    requireResourceId: boolean,
    signal?: AbortSignal,
  ): Promise<StableTapTargetResult> {
    return resolveAndroidStableTapTarget(
      {
        timer: this.host.timer,
        elementParser: this.host.elementParser(),
        findElementInHierarchy: (opts, hierarchy) =>
          this.host.findElementInHierarchy(opts, hierarchy),
        resolveTapTargetElement: (element, hierarchy, tapAction, tapOptions) =>
          this.host.resolveTapTargetElement(element, hierarchy, tapAction, tapOptions),
        staleSyntheticTarget: (original, previous, current) =>
          this.host.staleSyntheticTarget(original, previous, current),
        tapVerificationRefresh: (context) => this.tapVerificationRefresh(context),
        withObservationScreenSize: (opts, observation) =>
          this.host.withObservationScreenSize(opts, observation),
      },
      { options, observeResult, action, requireResourceId, signal },
    );
  }
}

/**
 * A synthetic (view-id only) tap target is stale when the refreshed hierarchy no
 * longer resolves its reference to the same node.
 */
export function staleSyntheticTarget(
  original: Element | null,
  previous: ViewHierarchyResult | undefined,
  current: ViewHierarchyResult,
): string | undefined {
  if (!original || original["resource-id"] || !original["view-id"] || !previous) {
    return undefined;
  }
  const projection = new SearchableHierarchy();
  const nodeKey = original["view-id"];
  const oldNode = projection.project(previous).find((node) => node.nodeKey === nodeKey);
  if (!oldNode) {
    return "Stale tap target: the observed reference is no longer identifiable.";
  }
  const oldId = getHierarchySnapshot(previous)?.captureId ?? "before-refresh";
  const newId =
    getHierarchySnapshot(current)?.captureId ?? (previous === current ? oldId : "after-refresh");
  const result = new ElementResolver().resolve(
    { id: newId, nodes: projection.project(current) },
    { elementId: nodeKey },
    {
      action: "inspect",
      ref: {
        snapshotId: oldId,
        nodeKey,
        bounds: oldNode.bounds,
        label: oldNode.label,
        nativeId: oldNode.nativeId,
      },
    },
  );
  return result.error;
}
