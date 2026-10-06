import type { BootedDevice, DisplayRef, ObserveResult } from "../../models";
import { POSTURE_PANEL_ROLES } from "../../models/DisplayPanel";
import { DaemonState } from "../../daemon/daemonState";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { ScreenshotJobTracker } from "../../utils/ScreenshotJobTracker";
import { defaultDisplayInventoryProvider } from "../../devices/DisplayInventoryProvider";
import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import { ObservedAndroidDisplayCache } from "./ObservationDisplay";
import { getObserveCacheStore } from "./cache/ObserveCacheRegistry";
import { getScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import {
  observationStreamFrameInvalidator,
  type ObservationFrameInvalidator,
} from "./ObservationFrameInvalidator";

interface PanelGeometry {
  key: string;
  role: DisplayRef["role"];
  posture: DisplayRef["posture"];
  width: number;
  height: number;
}

function identifiedPanel(panel: Pick<PanelGeometry, "key" | "role" | "posture">): boolean {
  return panel.key !== "0" && panel.role !== "unknown" && panel.posture !== "unknown";
}

function samePanelIdentity(
  current: Pick<PanelGeometry, "key" | "role" | "posture">,
  previous: PanelGeometry,
): boolean {
  return (
    current.key === previous.key &&
    current.role === previous.role &&
    current.posture === previous.posture
  );
}

/** Fields supplied by the Android display listener; no wire parser dependency. */
export interface PushedDisplayTransition {
  change: "added" | "changed" | "removed" | "device_state";
  displayId: number;
  panelUniqueId?: string;
  width?: number;
  height?: number;
  deviceState?: number;
}

/** Entry points shared by observe-detected and CtrlProxy-pushed transitions. */
export interface DisplayTransitionSink {
  revision(deviceId: string): number;
  identityRevision(deviceId: string): number;
  notifyTransition(deviceId: string, reason: string): void;
  rememberIosPosture(
    device: BootedDevice,
    display: DisplayRef,
    posture: DisplayRef["posture"],
  ): DisplayRef;
  notifyAndroidTransition(deviceId: string, event: PushedDisplayTransition): void;
}

/** Read-only transition seam for coordinate-action fences. */
export interface DisplayTransitionReader {
  revision(deviceId: string): number;
  identityRevision(deviceId: string): number;
  sameIdentitySince(deviceId: string, renderedRevision: number): boolean;
  currentObservedPanel(deviceId: string): Pick<DisplayRef, "key" | "role"> | undefined;
}

/** Tracker provenance captured before asynchronous observation work starts. */
export interface DisplayCaptureStart {
  revision: number;
  identityRevision: number;
}

function samePanelAndGeometry(
  current: PanelGeometry,
  previous: PanelGeometry,
  orientationAware: boolean,
): boolean {
  return (
    current.key === previous.key &&
    current.role === previous.role &&
    current.posture === previous.posture &&
    ((current.width === previous.width && current.height === previous.height) ||
      (!orientationAware && current.width === previous.height && current.height === previous.width))
  );
}

function pushedPanelKey(event: PushedDisplayTransition): string | undefined {
  return event.panelUniqueId?.includes(":")
    ? event.panelUniqueId.split(":").slice(1).join(":")
    : event.panelUniqueId;
}

function samePushedPanel(
  event: PushedDisplayTransition,
  previous: Pick<PanelGeometry, "key" | "width" | "height">,
): boolean {
  const key = pushedPanelKey(event);
  return (
    (!key || key === previous.key) &&
    (event.width === undefined ||
      event.height === undefined ||
      (event.width === previous.width && event.height === previous.height) ||
      (event.width === previous.height && event.height === previous.width))
  );
}

/**
 * A display appearing or disappearing (any id) and a secondary display changing alter the
 * panel inventory. A default-display change or posture state is handled by the transition
 * it produces (`notifyTransition`), so a rotation-only push keeps the cached inventory.
 */
function inventoryChangedByPush(event: PushedDisplayTransition): boolean {
  return (
    event.change === "added" ||
    event.change === "removed" ||
    (event.change !== "device_state" && event.displayId !== 0)
  );
}

export class DisplayTransitionTracker implements DisplayTransitionSink, DisplayTransitionReader {
  private readonly panels = new Map<string, PanelGeometry>();
  private readonly observationIds = new Map<string, string>();
  private readonly panelRevisions = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private readonly identityRevisions = new Map<string, number>();
  private readonly lastIdentityChangeRevisions = new Map<string, number>();
  private readonly pendingPushes = new Map<
    string,
    {
      revision: number;
      displayCallbackSeen: boolean;
      stateCallbackSeen: boolean;
      panel?: Pick<PanelGeometry, "key" | "width" | "height">;
    }
  >();
  private readonly deviceStates = new Map<string, number>();
  private readonly listeners = new Map<
    string,
    Set<(panel?: Pick<DisplayRef, "key" | "role">) => void>
  >();

  constructor(
    private readonly invalidate: (deviceId: string, reason: string) => void,
    /**
     * Drops the device's cached display inventory (panels and postures) so the next
     * tool call re-reads it. Injected so this tracker never imports the provider.
     */
    private readonly invalidateInventory: (deviceId: string) => void = () => {},
  ) {}

  revision(deviceId: string): number {
    return this.revisions.get(deviceId) ?? 0;
  }

  /**
   * Canonical surfaced generation and action fence. Device removal/session release
   * resets it via reset() for a fresh session; CtrlProxy restarts never reset it.
   * A geometry correction within one identified observation leaves it stable.
   */
  identityRevision(deviceId: string): number {
    return this.identityRevisions.get(deviceId) ?? 0;
  }

  /** Whether a previously rendered full revision still targets this iOS panel/posture. */
  sameIdentitySince(deviceId: string, renderedRevision: number): boolean {
    return (
      renderedRevision >= (this.lastIdentityChangeRevisions.get(deviceId) ?? 0) &&
      renderedRevision <= this.revision(deviceId)
    );
  }

  /** Most recent accepted observation stamp, unless a push has fenced it. */
  observedPanel(deviceId: string): Pick<DisplayRef, "key" | "role"> | undefined {
    if (this.hasPendingPush(deviceId)) {
      return undefined;
    }
    const panel = this.panels.get(deviceId);
    return panel ? { key: panel.key, role: panel.role } : undefined;
  }

  private hasPendingPush(deviceId: string): boolean {
    return this.pendingPushes.get(deviceId)?.revision === this.revision(deviceId);
  }

  /** A panel accepted by an observation after the latest transition fence. */
  currentObservedPanel(deviceId: string): Pick<DisplayRef, "key" | "role"> | undefined {
    return this.panelRevisions.get(deviceId) === this.revision(deviceId)
      ? this.observedPanel(deviceId)
      : undefined;
  }

  /** Subscribe to panel changes, including pushes that precede a fresh observation. */
  subscribe(
    deviceId: string,
    listener: (panel?: Pick<DisplayRef, "key" | "role">) => void,
  ): () => void {
    const listeners = this.listeners.get(deviceId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(deviceId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(deviceId);
      }
    };
  }

  private emitPanel(deviceId: string, panel?: Pick<DisplayRef, "key" | "role">): void {
    for (const listener of this.listeners.get(deviceId) ?? []) {
      listener(panel);
    }
  }

  geometryChanged(deviceId: string, size: ObserveResult["screenSize"]): boolean {
    const previous = this.panels.get(deviceId);
    return (
      previous !== undefined && (previous.width !== size.width || previous.height !== size.height)
    );
  }

  /** Fence an iOS geometry change before the new observation is recorded. */
  checkIosGeometry(
    deviceId: string,
    size: ObserveResult["screenSize"],
    observationId?: string,
    display?: DisplayRef,
  ): boolean {
    if (!this.geometryChanged(deviceId, size)) {
      return false;
    }
    const previous = this.panels.get(deviceId)!;
    previous.width = size.width;
    previous.height = size.height;
    if (
      observationId &&
      this.observationIds.get(deviceId) === observationId &&
      identifiedPanel(previous) &&
      display &&
      identifiedPanel(display) &&
      previous.key === display.key &&
      previous.posture === display.posture
    ) {
      this.notifyGeometryTransition(deviceId, "iOS display geometry corrected within observation");
    } else {
      this.notifyTransition(deviceId, "iOS display geometry changed");
    }
    return true;
  }

  /** Compare identity before hierarchy collection, so a new panel cannot hit the old cache. */
  checkIdentity(
    deviceId: string,
    display: DisplayRef,
    platform: "ios" | "android" = "android",
  ): boolean {
    const previous = this.panels.get(deviceId);
    if (!previous || samePanelIdentity(display, previous)) {
      return false;
    }
    if (this.hasPendingPush(deviceId)) {
      return false;
    }
    this.panels.delete(deviceId);
    if (
      platform === "ios" &&
      identifiedPanel(previous) &&
      identifiedPanel(display) &&
      previous.key === display.key &&
      previous.posture === display.posture
    ) {
      this.notifyGeometryTransition(deviceId, "display role changed");
    } else {
      this.notifyTransition(deviceId, "display key, role, or posture changed");
    }
    if (previous.key !== display.key || previous.role !== display.role) {
      this.emitPanel(deviceId, display);
    }
    return true;
  }

  /** Compare the finalized hierarchy's pixel geometry as well as physical identity. */
  record(
    deviceId: string,
    result: Pick<ObserveResult, "display" | "screenSize"> &
      Partial<Pick<ObserveResult, "observationId">>,
    platform: "ios" | "android" = "android",
    captureStart: DisplayCaptureStart = {
      revision: this.revision(deviceId),
      identityRevision: this.identityRevision(deviceId),
    },
  ): boolean {
    // A pre-transition capture cannot reconcile the new panel or consume its fence.
    if (captureStart.revision !== this.revision(deviceId)) {
      return false;
    }
    // The first fresh observation with usable geometry after a push consumes
    // its fence, even if the stamp is unchanged.
    const pushedFence = this.hasPendingPush(deviceId);
    const { width, height } = result.screenSize;
    if (width <= 0 || height <= 0) {
      return false;
    }
    this.pendingPushes.delete(deviceId);
    const current = {
      key: result.display.key,
      role: result.display.role,
      posture: result.display.posture,
      width,
      height,
    };
    const previous = this.panels.get(deviceId);
    const sameObservation = this.recordPanel(deviceId, current, result.observationId);
    if (pushedFence) {
      this.emitPanel(deviceId, current);
      return false;
    }
    if (!previous) {
      return false;
    }
    if (samePanelAndGeometry(current, previous, platform === "ios")) {
      return false;
    }
    this.notifyObservedTransition(deviceId, current, previous, platform, sameObservation);
    this.panelRevisions.set(deviceId, this.revision(deviceId));
    if (previous.key !== current.key || previous.role !== current.role) {
      this.emitPanel(deviceId, current);
    }
    return true;
  }

  private recordPanel(deviceId: string, panel: PanelGeometry, observationId?: string): boolean {
    const sameObservation =
      observationId !== undefined && this.observationIds.get(deviceId) === observationId;
    this.panels.set(deviceId, panel);
    if (observationId) {
      this.observationIds.set(deviceId, observationId);
    } else {
      this.observationIds.delete(deviceId);
    }
    this.panelRevisions.set(deviceId, this.revision(deviceId));
    return sameObservation;
  }

  private notifyObservedTransition(
    deviceId: string,
    current: PanelGeometry,
    previous: PanelGeometry,
    platform: "ios" | "android",
    sameObservation: boolean,
  ): void {
    if (
      platform === "ios" &&
      sameObservation &&
      identifiedPanel(current) &&
      identifiedPanel(previous) &&
      current.key === previous.key &&
      current.posture === previous.posture
    ) {
      this.notifyGeometryTransition(deviceId, "display geometry changed");
      return;
    }
    this.notifyTransition(deviceId, "display geometry changed");
  }

  /** Align reconciliation with the successful command after its final transition fence. */
  rememberIosPosture(
    device: BootedDevice,
    display: DisplayRef,
    posture: DisplayRef["posture"],
  ): DisplayRef {
    const expectedRole = POSTURE_PANEL_ROLES.find(
      ([value]) => value === (posture === "half_opened" ? "opened" : posture),
    )?.[1];
    if ((device.displays?.panels.length ?? 0) < 2 || display.role !== expectedRole) {
      return display;
    }
    const remembered = { ...display, posture };
    ObservedAndroidDisplayCache.rememberIosPosture(device.deviceId, remembered);
    const panel = this.panels.get(device.deviceId);
    if (panel?.key === display.key && panel.role === display.role) {
      panel.posture = posture;
    }
    return remembered;
  }

  notifyTransition(deviceId: string, reason: string): void {
    // A panel or posture transition can add, remove or resize a panel; never serve
    // the pre-transition inventory to the next call.
    this.invalidateInventory(deviceId);
    ObservedAndroidDisplayCache.clear(deviceId);
    this.identityRevisions.set(deviceId, this.identityRevision(deviceId) + 1);
    this.notifyGeometryTransition(deviceId, reason);
    this.lastIdentityChangeRevisions.set(deviceId, this.revision(deviceId));
  }

  private notifyGeometryTransition(deviceId: string, reason: string): void {
    this.revisions.set(deviceId, this.revision(deviceId) + 1);
    this.invalidate(deviceId, reason);
  }

  /** A push fences actions before the next observe, which then reconciles the new stamp. */
  notifyAndroidTransition(deviceId: string, event: PushedDisplayTransition): void {
    if (inventoryChangedByPush(event)) {
      this.invalidateInventory(deviceId);
    }
    if (event.change !== "device_state" && event.displayId !== 0) {
      // A secondary display must not bump the default panel's generation.
      return;
    }
    const previous = this.panelBeforePush(deviceId);
    if (event.change === "device_state") {
      if (event.deviceState === undefined) {
        return;
      }
      if (this.deviceStates.get(deviceId) === event.deviceState) {
        this.markPendingCallbackSeen(deviceId, "stateCallbackSeen");
        return;
      }
      this.deviceStates.set(deviceId, event.deviceState);
    } else if (event.change === "changed" && previous) {
      if (samePushedPanel(event, previous)) {
        this.markPendingCallbackSeen(deviceId, "displayCallbackSeen");
        return;
      }
    }
    if (this.reconcilePendingPush(deviceId, event)) {
      return;
    }
    this.notifyTransition(deviceId, `CtrlProxy ${event.change}`);
    const key = pushedPanelKey(event);
    this.emitPanel(deviceId, key ? { key, role: "unknown" } : undefined);
    this.pendingPushes.set(deviceId, {
      revision: this.revision(deviceId),
      displayCallbackSeen: event.change !== "device_state",
      stateCallbackSeen: event.change === "device_state",
      panel: this.panelFromPush(deviceId, event),
    });
  }

  private markPendingCallbackSeen(
    deviceId: string,
    callback: "displayCallbackSeen" | "stateCallbackSeen",
  ): void {
    const pending = this.pendingPushes.get(deviceId);
    if (pending?.revision === this.revision(deviceId)) {
      pending[callback] = true;
    }
  }

  private panelBeforePush(
    deviceId: string,
  ): Pick<PanelGeometry, "key" | "width" | "height"> | undefined {
    if (!this.hasPendingPush(deviceId)) {
      return this.panels.get(deviceId);
    }
    return this.pendingPushes.get(deviceId)?.panel ?? this.panels.get(deviceId);
  }

  private panelFromPush(
    deviceId: string,
    event: PushedDisplayTransition,
  ): Pick<PanelGeometry, "key" | "width" | "height"> | undefined {
    const key = pushedPanelKey(event);
    if (!key) {
      return undefined;
    }
    const previous = this.panelBeforePush(deviceId);
    return {
      key,
      width: event.width ?? previous?.width ?? 0,
      height: event.height ?? previous?.height ?? 0,
    };
  }

  private reconcilePendingPush(deviceId: string, event: PushedDisplayTransition): boolean {
    const pending = this.pendingPushes.get(deviceId);
    if (pending?.revision !== this.revision(deviceId)) {
      return false;
    }
    if (event.change === "changed") {
      // A state callback may carry the old panel snapshot; only callback kind
      // determines whether this is the complementary display callback.
      const corroboratesState = !pending.displayCallbackSeen;
      pending.displayCallbackSeen = true;
      pending.panel = this.panelFromPush(deviceId, event);
      return corroboratesState;
    }
    if (event.change !== "device_state") {
      return true;
    }
    // The first state callback can corroborate a display callback for the same
    // fold. A subsequent distinct state is another transition, not a duplicate.
    const corroboratesDisplay = !pending.stateCallbackSeen;
    pending.stateCallbackSeen = true;
    return corroboratesDisplay;
  }

  reset(deviceId: string): void {
    this.panels.delete(deviceId);
    this.observationIds.delete(deviceId);
    this.panelRevisions.delete(deviceId);
    this.revisions.delete(deviceId);
    this.identityRevisions.delete(deviceId);
    this.lastIdentityChangeRevisions.delete(deviceId);
    this.pendingPushes.delete(deviceId);
    this.deviceStates.delete(deviceId);
    ObservedAndroidDisplayCache.release(deviceId);
  }
}

export function createDisplayCacheInvalidator(
  frameInvalidator: ObservationFrameInvalidator = observationStreamFrameInvalidator,
): (deviceId: string, reason: string) => void {
  return (deviceId, reason) => {
    logger.info(`[DisplayTransition] ${deviceId}: ${reason}; clearing panel-scoped state`);
    try {
      frameInvalidator.invalidateDeviceFrames(deviceId);
    } catch (error) {
      logger.warn(
        `[DisplayTransition] Failed to invalidate observation frames for ${deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
    getObserveCacheStore().clear(deviceId);
    getScreenshotStateStore().clear(deviceId);
    ScreenshotJobTracker.cancelJob(deviceId);
    ObservedAndroidDisplayCache.clear(deviceId);
    const android = AndroidCtrlProxyClient.getExistingInstance(deviceId);
    if (android) {
      android.screenGeometry.clear();
      android.invalidateCache();
    }
    const ios = IOSCtrlProxyClient.getExistingInstance(deviceId);
    if (ios) {
      ios.clearDisplayProvenance();
    }
    const daemon = DaemonState.getInstance();
    if (daemon.isInitialized()) {
      const sessions = daemon.getSessionManager();
      const sessionId = sessions.getSessionForDevice(deviceId);
      if (sessionId) {
        sessions.clearSessionCache(sessionId, "lastHierarchy");
        sessions.clearSessionCache(sessionId, "lastObserveTime");
        sessions.clearSessionCache(sessionId, "lastRenderedObservation");
      }
    }
  };
}

export const invalidateDisplayCaches = createDisplayCacheInvalidator();

export const displayTransitions: DisplayTransitionTracker = new DisplayTransitionTracker(
  invalidateDisplayCaches,
  (deviceId) => defaultDisplayInventoryProvider.invalidate(deviceId),
);
