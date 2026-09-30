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

/** The future CtrlProxy display_transition frame needs only this narrow entry point. */
export interface DisplayTransitionSink {
  notifyTransition(deviceId: string, reason: string): void;
}

export class DisplayTransitionTracker implements DisplayTransitionSink {
  private readonly panels = new Map<string, PanelGeometry>();
  private readonly revisions = new Map<string, number>();

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
    this.panels.delete(deviceId);
    this.notifyTransition(deviceId, "display key, role, or posture changed");
    return true;
  }

  /** Compare the finalized hierarchy's pixel geometry as well as physical identity. */
  record(deviceId: string, result: Pick<ObserveResult, "display" | "screenSize">): boolean {
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
    if (
      !previous ||
      (current.key === previous.key &&
        current.role === previous.role &&
        current.posture === previous.posture &&
        ((current.width === previous.width && current.height === previous.height) ||
          (current.width === previous.height && current.height === previous.width)))
    ) {
      return false;
    }
    this.notifyTransition(deviceId, "display geometry changed");
    return true;
  }

  notifyTransition(deviceId: string, reason: string): void {
    this.revisions.set(deviceId, this.revision(deviceId) + 1);
    this.invalidate(deviceId, reason);
  }

  reset(deviceId: string): void {
    this.panels.delete(deviceId);
    this.revisions.delete(deviceId);
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
