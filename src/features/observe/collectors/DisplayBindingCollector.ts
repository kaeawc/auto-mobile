import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice, ObserveResult } from "../../../models";
import { displayTransitions } from "../DisplayTransition";
import { DisplaySelectionError, resolveTargetDisplay } from "../DisplaySelection";
import {
  type ObservedAndroidDisplay,
  type ObservedAndroidDisplayCache,
} from "../ObservationDisplay";

/** Provenance of the last display-transition record taken for one observation. */
export interface DisplayRecordProvenance {
  revision: number;
  identityRevision: number;
}

/** What the observation needs to know about the display it targets, before capture. */
export interface DisplayTargetBinding {
  observedAndroid: ObservedAndroidDisplay | undefined;
  explicitlyRouted: boolean;
  requestedPanel: ReturnType<typeof resolveTargetDisplay> | undefined;
  requestedDisplayId: number | undefined;
}

export interface DisplayTargetContext {
  result: ObserveResult;
  displayRequest: string | undefined;
  androidDisplayCache: ObservedAndroidDisplayCache;
  signal: AbortSignal | undefined;
}

export interface FinalDisplayBindingContext {
  result: ObserveResult;
  displayRequest: string | undefined;
  androidDisplayCache: ObservedAndroidDisplayCache;
  observedAndroid: ObservedAndroidDisplay | undefined;
  requestedPanel: DisplayTargetBinding["requestedPanel"];
  requestedDisplayId: number | undefined;
  explicitlyRouted: boolean;
  preserveDisplayState: boolean;
  observerMode: boolean;
  recordProvenance: DisplayRecordProvenance;
  signal: AbortSignal | undefined;
}

export interface FinalDisplayBinding {
  recordProvenance: DisplayRecordProvenance;
}

/**
 * Per-platform display binding for one observation. Methods return a plain value when the
 * platform needs no device read, and a promise only when it does, so the caller awaits only the
 * asynchronous platform and the other adds no microtask tick.
 */
export interface DisplayBindingCollector {
  /** Resolve the targeted display before the hierarchy is captured. */
  resolveTarget(
    context: DisplayTargetContext,
  ): DisplayTargetBinding | Promise<DisplayTargetBinding>;
  /** Bind the final hierarchy's panel after reconciliation, before screenshot routing. */
  bindFinalDisplay(
    context: FinalDisplayBindingContext,
  ): FinalDisplayBinding | Promise<FinalDisplayBinding>;
}

export interface DisplayBindingCollectorDeps {
  device: () => BootedDevice;
  adb: () => AdbExecutor;
}

export function resolveExplicitTarget(
  device: BootedDevice,
  context: Pick<DisplayTargetContext, "result" | "displayRequest">,
  observedAndroid: ObservedAndroidDisplay | undefined,
) {
  const { result, displayRequest } = context;
  const explicitlyRouted = displayRequest !== undefined && displayRequest !== "active";
  const requestedPanel = explicitlyRouted
    ? resolveTargetDisplay(device.displays, displayRequest, {
        activePanelKey: observedAndroid?.display.key,
        posture: result.display.posture,
      })
    : undefined;
  return { explicitlyRouted, requestedPanel };
}

export function reconcileIosDisplayTransition(
  deviceId: string,
  result: ObserveResult,
  explicitlyRouted: boolean,
  hasMultiplePanels: boolean,
): void {
  if (explicitlyRouted) {
    return;
  }
  displayTransitions.checkIdentity(deviceId, result.display, "ios");
  if (hasMultiplePanels) {
    displayTransitions.checkIosGeometry(
      deviceId,
      result.screenSize,
      result.observationId,
      result.display,
    );
  }
}

function isUnreadableHierarchy(result: ObserveResult): boolean {
  return Boolean(
    result.viewHierarchy?.hierarchy?.error ||
    result.viewHierarchy?.hierarchy?.unavailableReason ||
    (result.viewHierarchy?.ctrlProxyIncomplete && !result.viewHierarchy.hierarchy?.node),
  );
}

/** A routed Android observation must return the display it asked for. */
function assertRoutedDisplayReported(
  { result, requestedPanel, requestedDisplayId, preserveDisplayState }: FinalDisplayBindingContext,
  reportedId: number | null | undefined,
  panelUniqueId: string | null | undefined,
): void {
  if (
    requestedDisplayId !== undefined &&
    typeof reportedId !== "number" &&
    !panelUniqueId &&
    !(preserveDisplayState && isUnreadableHierarchy(result))
  ) {
    throw new DisplaySelectionError(
      "CtrlProxy APK too old for display routing; update it and retry the observation.",
    );
  }
  if (
    requestedDisplayId !== undefined &&
    typeof reportedId === "number" &&
    reportedId !== requestedDisplayId
  ) {
    throw new DisplaySelectionError(
      `Selected display "${requestedPanel?.key}" returned hierarchy for display ${reportedId}; retry the observation.`,
    );
  }
}

function assertFocusedPanelIsRequested(
  requestedPanel: DisplayTargetBinding["requestedPanel"],
  focusedPanel: { key: string } | undefined,
): void {
  if (requestedPanel && focusedPanel && requestedPanel.key !== focusedPanel.key) {
    throw new DisplaySelectionError(
      `Selected display "${requestedPanel.key}" returned content from "${focusedPanel.key}"; retry the observation.`,
    );
  }
}

export class AndroidDisplayBindingCollector implements DisplayBindingCollector {
  constructor(private readonly deps: DisplayBindingCollectorDeps) {}

  resolveTarget(context: DisplayTargetContext): Promise<DisplayTargetBinding> {
    return this.resolveTargetAsync(context);
  }

  private async resolveTargetAsync(context: DisplayTargetContext): Promise<DisplayTargetBinding> {
    const { result, androidDisplayCache, signal } = context;
    const device = this.deps.device();
    const adb = this.deps.adb();
    const observedAndroid = await androidDisplayCache.resolve(device, adb, signal);
    if (observedAndroid) {
      result.display = observedAndroid.display;
    }
    const { explicitlyRouted, requestedPanel } = resolveExplicitTarget(
      device,
      context,
      observedAndroid,
    );
    const requestedDisplayId = requestedPanel
      ? await androidDisplayCache.logicalIdForPanel(device, adb, requestedPanel.key, signal)
      : undefined;
    if (requestedPanel) {
      result.display = { ...result.display, key: requestedPanel.key, role: requestedPanel.role };
    }
    return { observedAndroid, explicitlyRouted, requestedPanel, requestedDisplayId };
  }

  bindFinalDisplay(
    context: FinalDisplayBindingContext,
  ): FinalDisplayBinding | Promise<FinalDisplayBinding> {
    if (!this.deps.device().displays?.panels.length) {
      return { recordProvenance: context.recordProvenance };
    }
    return this.bindFinalDisplayAsync(context);
  }

  private async bindFinalDisplayAsync(
    context: FinalDisplayBindingContext,
  ): Promise<FinalDisplayBinding> {
    const {
      result,
      androidDisplayCache,
      observedAndroid,
      requestedPanel,
      explicitlyRouted,
      signal,
    } = context;
    let recordProvenance = context.recordProvenance;
    const device = this.deps.device();
    const adb = this.deps.adb();
    const reportedId = result.viewHierarchy?.displayId;
    const panelUniqueId = result.viewHierarchy?.panelUniqueId;
    assertRoutedDisplayReported(context, reportedId, panelUniqueId);
    const focusedPanel =
      typeof reportedId === "number" || panelUniqueId
        ? await androidDisplayCache.panelForLogicalId(device, adb, reportedId, {
            signal,
            identity: { panelUniqueId, panelFingerprint: result.viewHierarchy?.panelFingerprint },
            allowProbe: explicitlyRouted,
          })
        : undefined;
    assertFocusedPanelIsRequested(requestedPanel, focusedPanel);
    const geometryChanged = displayTransitions.geometryChanged(device.deviceId, result.screenSize);
    const refreshed =
      geometryChanged && !explicitlyRouted
        ? await androidDisplayCache.resolve(device, adb, signal, true)
        : observedAndroid;
    result.display.posture = await androidDisplayCache.posture(
      device,
      adb,
      signal,
      geometryChanged && !explicitlyRouted,
    );
    this.applyBoundPanel(context, device, focusedPanel?.key, refreshed?.display.key);
    recordProvenance = this.recordFinalIdentity(context, device, recordProvenance);
    return { recordProvenance };
  }

  private applyBoundPanel(
    { result, displayRequest, requestedPanel }: FinalDisplayBindingContext,
    device: BootedDevice,
    focusedPanelKey: string | undefined,
    activePanelKey: string | undefined,
  ): void {
    const panel =
      requestedPanel ??
      resolveTargetDisplay(device.displays, displayRequest, {
        focusedPanelKey,
        activePanelKey,
        posture: result.display.posture,
      });
    result.display = { ...result.display, key: panel.key, role: panel.role };
  }

  private recordFinalIdentity(
    { result, explicitlyRouted, preserveDisplayState, observerMode }: FinalDisplayBindingContext,
    device: BootedDevice,
    recordProvenance: DisplayRecordProvenance,
  ): DisplayRecordProvenance {
    if (
      !explicitlyRouted &&
      !preserveDisplayState &&
      !observerMode &&
      displayTransitions.revision(device.deviceId) === recordProvenance.revision
    ) {
      displayTransitions.checkIdentity(device.deviceId, result.display);
      recordProvenance = {
        revision: displayTransitions.revision(device.deviceId),
        identityRevision: displayTransitions.identityRevision(device.deviceId),
      };
    }
    return recordProvenance;
  }
}
