import type { DeviceLockState } from "../../models";
import type { NavigationGraphService } from "../navigation/NavigationGraphManager";
import type { PredictionActionContext } from "../observe/PredictionAnalyzer";
import type { ObservedChangeOptions } from "./observedInteractionTypes";

export function buildDeviceLockWarning(lock: DeviceLockState): string {
  const preamble = "Device is locked; this interaction likely did not reach the app under test.";
  if (lock.secure === true) {
    return `${preamble} The lock is secure (PIN/pattern/password) — ask the user to unlock the device before continuing.`;
  }
  if (lock.secure === false) {
    return `${preamble} The lock is a swipe lock — dismiss the keyguard (e.g. swipe up) before continuing.`;
  }
  return `${preamble} Unlock or dismiss the keyguard before continuing.`;
}

/**
 * Build the prediction context for the graph this device's navigation events are recorded on
 * (its bound session's, else the global one); the graph is resolved once, lazily, so the
 * outcome is judged on the graph the context came from.
 */
export function buildPredictionActionContext(
  context: ObservedChangeOptions["predictionContext"],
  resolveNavigationGraph: () => NavigationGraphService,
): PredictionActionContext | undefined {
  if (!context) {
    return undefined;
  }
  const navigationGraph = resolveNavigationGraph();
  const appId = navigationGraph.getCurrentAppId();
  const fromScreen = navigationGraph.getCurrentScreen();
  if (!appId || !fromScreen) {
    return undefined;
  }
  return {
    appId,
    fromScreen,
    toolName: context.toolName,
    toolArgs: context.toolArgs,
    navigationGraph,
  };
}
