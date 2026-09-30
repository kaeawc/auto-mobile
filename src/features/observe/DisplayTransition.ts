import type { DisplayRef, ObserveResult } from "../../models";
import { DaemonState } from "../../daemon/daemonState";
import { logger } from "../../utils/logger";
import { ScreenshotJobTracker } from "../../utils/ScreenshotJobTracker";
import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import { ObservedAndroidDisplayCache } from "./ObservationDisplay";
import { getObserveCacheStore } from "./cache/ObserveCacheRegistry";
import { getScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";

interface PanelGeometry {
  key: string;
  role: DisplayRef["role"];
  posture: DisplayRef["posture"];
  width: number;
  height: number;
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
  notifyTransition(deviceId: string, reason: string): void;
  notifyAndroidTransition(deviceId: string, event: PushedDisplayTransition): void;
}

function samePanelAndGeometry(current: PanelGeometry, previous: PanelGeometry): boolean {
  return (
    current.key === previous.key &&
    current.role === previous.role &&
    current.posture === previous.posture &&
    ((current.width === previous.width && current.height === previous.height) ||
      (current.width === previous.height && current.height === previous.width))
  );
}

function samePushedPanel(event: PushedDisplayTransition, previous: PanelGeometry): boolean {
  const key = event.panelUniqueId?.includes(":")
    ? event.panelUniqueId.split(":").slice(1).join(":")
    : event.panelUniqueId;
  return (
    (!key || key === previous.key) &&
    (event.width === undefined ||
      event.height === undefined ||
      (event.width === previous.width && event.height === previous.height) ||
      (event.width === previous.height && event.height === previous.width))
  );
}

export class DisplayTransitionTracker implements DisplayTransitionSink {
  private readonly panels = new Map<string, PanelGeometry>();
  private readonly revisions = new Map<string, number>();
  private readonly pendingPushes = new Map<string, number>();
  private readonly deviceStates = new Map<string, number>();

  constructor(private readonly invalidate: (deviceId: string, reason: string) => void) {}

  revision(deviceId: string): number {
    return this.revisions.get(deviceId) ?? 0;
  }

  geometryChanged(deviceId: string, size: ObserveResult["screenSize"]): boolean {
    const previous = this.panels.get(deviceId);
    return (
      previous !== undefined && (previous.width !== size.width || previous.height !== size.height)
    );
  }

  /** Compare identity before hierarchy collection, so a new panel cannot hit the old cache. */
  checkIdentity(deviceId: string, display: DisplayRef): boolean {
    const previous = this.panels.get(deviceId);
    if (
      !previous ||
      (previous.key === display.key &&
        previous.role === display.role &&
        previous.posture === display.posture)
    ) {
      return false;
    }
    if (this.pendingPushes.get(deviceId) === this.revision(deviceId)) {
      return false;
    }
    this.panels.delete(deviceId);
    this.notifyTransition(deviceId, "display key, role, or posture changed");
    return true;
  }

  /** Compare the finalized hierarchy's pixel geometry as well as physical identity. */
  record(deviceId: string, result: Pick<ObserveResult, "display" | "screenSize">): boolean {
    // The first completed observation after a push consumes its fence, even if
    // the stamp is unchanged or the observation has no usable geometry.
    const pushedRevision = this.pendingPushes.get(deviceId);
    this.pendingPushes.delete(deviceId);
    const { width, height } = result.screenSize;
    if (width <= 0 || height <= 0) {
      return false;
    }
    const current = {
      key: result.display.key,
      role: result.display.role,
      posture: result.display.posture,
      width,
      height,
    };
    const previous = this.panels.get(deviceId);
    this.panels.set(deviceId, current);
    const unchanged = previous !== undefined && samePanelAndGeometry(current, previous);
    if (pushedRevision === this.revision(deviceId)) {
      return false;
    }
    if (!previous || unchanged) {
      return false;
    }
    this.notifyTransition(deviceId, "display geometry changed");
    return true;
  }

  notifyTransition(deviceId: string, reason: string): void {
    this.revisions.set(deviceId, this.revision(deviceId) + 1);
    this.invalidate(deviceId, reason);
  }

  /** A push fences actions before the next observe, which then reconciles the new stamp. */
  notifyAndroidTransition(deviceId: string, event: PushedDisplayTransition): void {
    if (event.change !== "device_state" && event.displayId !== 0) {
      return;
    }
    const previous = this.panels.get(deviceId);
    if (event.change === "device_state") {
      if (
        event.deviceState === undefined ||
        this.deviceStates.get(deviceId) === event.deviceState
      ) {
        return;
      }
      this.deviceStates.set(deviceId, event.deviceState);
    } else if (event.change === "changed" && previous) {
      if (samePushedPanel(event, previous)) {
        return;
      }
    }
    if (this.pendingPushes.get(deviceId) === this.revision(deviceId)) {
      return;
    }
    this.notifyTransition(deviceId, `CtrlProxy ${event.change}`);
    this.pendingPushes.set(deviceId, this.revision(deviceId));
  }

  reset(deviceId: string): void {
    this.panels.delete(deviceId);
    this.revisions.delete(deviceId);
    this.pendingPushes.delete(deviceId);
    this.deviceStates.delete(deviceId);
    ObservedAndroidDisplayCache.release(deviceId);
  }
}

function invalidateDisplayCaches(deviceId: string, reason: string): void {
  logger.info(`[DisplayTransition] ${deviceId}: ${reason}; clearing panel-scoped state`);
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
}

export const displayTransitions: DisplayTransitionTracker = new DisplayTransitionTracker(
  invalidateDisplayCaches,
);
