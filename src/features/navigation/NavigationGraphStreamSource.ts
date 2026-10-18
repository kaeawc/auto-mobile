import type { NavigationGraphManager } from "./NavigationGraphManager";

/**
 * Narrow view of NavigationGraphManager for the daemon's navigation-graph stream
 * wiring: seeding build contexts, listening for graph/build-context changes and
 * exporting summaries (#11863).
 */
export type NavigationGraphStreamSource = Pick<
  NavigationGraphManager,
  | "getBuildContexts"
  | "setBuildContextUpdateListener"
  | "setGraphUpdateListener"
  | "exportGraphSummary"
  | "exportGraphSummaryForApp"
  | "getDeviceIdForApp"
>;
