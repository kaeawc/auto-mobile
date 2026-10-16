import { ENV, readEnvBool } from "../../config/env";
import { serverConfig } from "../../utils/ServerConfig";
import { isDebugPerfEnabled } from "../../utils/PerformanceTracker";

export function isPerformanceAuditEnabled(): boolean {
  return (
    serverConfig.isUiPerfModeEnabled() &&
    isDebugPerfEnabled() &&
    !readEnvBool(ENV.DISABLE_PERF_AUDIT)
  );
}

/** Synthetic taps are an explicit opt-in, independent of the UI perf audit. */
export function isTouchLatencySamplingEnabled(): boolean {
  return readEnvBool(ENV.TOUCH_LATENCY_SAMPLING);
}
