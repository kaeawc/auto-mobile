import type { BootedDevice, ObserveResult } from "../../models";
import { logger } from "../../utils/logger";
import type { DisplayTransitionReader } from "../observe/DisplayTransition";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../observe/interfaces/ObserveScreen";
import type { ObservedChangeOptions } from "./observedInteractionTypes";
import { COORDINATE_ACTIONS } from "./visualChangeDisplayFence";

/** The two observe reads the refresh needs: the cached observation, and a fresh capture. */
export type PanelGeometryObserver = Pick<
  ObserveScreen,
  "execute" | "getMostRecentCachedObserveResult"
>;

/** Only the device's full display revision is compared; identity generations are not enough. */
export type PanelGeometryRevisionReader = Pick<DisplayTransitionReader, "revision">;

export interface PanelGeometryRefreshDependencies {
  observer: PanelGeometryObserver;
  transitions: PanelGeometryRevisionReader;
  /** True when the caller's rendered stamp is stale; the caller fence handles that action. */
  callerStampIsStale?: () => boolean;
  observeOptions?: ObserveScreenExecuteOptions;
}

export function isIosMultiPanel(device: Pick<BootedDevice, "platform" | "displays">): boolean {
  return device.platform === "ios" && (device.displays?.panels.length ?? 0) > 1;
}

type RefreshedAction = Pick<
  ObservedChangeOptions,
  "display" | "predictionContext" | "previousObservation"
>;

function refreshApplies(
  device: Pick<BootedDevice, "platform" | "displays">,
  action: RefreshedAction,
  callerStampIsStale: () => boolean,
): boolean {
  return (
    isIosMultiPanel(device) &&
    // An explicit display target resolves and fences its own panel.
    action.display === undefined &&
    COORDINATE_ACTIONS.has(action.predictionContext?.toolName ?? "") &&
    !callerStampIsStale()
  );
}

/**
 * On a multi-panel iOS device the runner maps coordinate gestures through the geometry it pinned
 * at its last hierarchy capture, so a fold or unfold since then would aim a gesture at the
 * previous panel (#17585). When the cached observation's display revision is missing or differs
 * from the current one, capture a fresh observation first: that re-pins the runner's geometry to
 * the current panel and refreshes the host cache the gesture then reads.
 *
 * Only unscoped coordinate actions (`toolName` in COORDINATE_ACTIONS, no explicit `display`) are
 * refreshed. A `previousObservation` the action captured itself at the current display revision
 * (tapOn, tapAny and swipeOn resolve their target from one) already re-pinned the runner, so it
 * stands in for the fresh capture (#17593). Returns the fresh observation when one was captured, or undefined otherwise. A failed
 * fresh capture propagates: dispatching on geometry known to be stale is worse than failing.
 */
export async function refreshStaleIosPanelGeometry(
  device: Pick<BootedDevice, "platform" | "displays" | "deviceId">,
  action: RefreshedAction,
  {
    observer,
    transitions,
    callerStampIsStale = () => false,
    observeOptions = {},
  }: PanelGeometryRefreshDependencies,
): Promise<ObserveResult | undefined> {
  if (!refreshApplies(device, action, callerStampIsStale)) {
    return undefined;
  }
  const currentRevision = transitions.revision(device.deviceId);
  if (action.previousObservation?.displayRevision === currentRevision) {
    return undefined;
  }
  const cached = await observer.getMostRecentCachedObserveResult();
  if (cached.error === undefined && cached.displayRevision === currentRevision) {
    return undefined;
  }
  logger.info(
    `[PANEL_GEOMETRY] Cached observation display revision ${cached.displayRevision ?? "none"} ` +
      `!= current ${currentRevision} on ${device.deviceId}; observing before ` +
      `${action.predictionContext?.toolName}`,
  );
  return observer.execute({ ...observeOptions, freshness: "fresh" });
}
