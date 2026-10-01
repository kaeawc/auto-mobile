import { serverConfig } from "../../utils/ServerConfig";
import { isDebugPerfEnabled } from "../../utils/PerformanceTracker";

const DISABLE_PERF_AUDIT_ENV = "AUTOMOBILE_DISABLE_PERF_AUDIT";
const TOUCH_LATENCY_SAMPLING_ENV = "AUTOMOBILE_TOUCH_LATENCY_SAMPLING";

function parseEnvBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isPerformanceAuditEnabled(): boolean {
  return (
    serverConfig.isUiPerfModeEnabled() &&
    isDebugPerfEnabled() &&
    !parseEnvBoolean(process.env[DISABLE_PERF_AUDIT_ENV])
  );
}

/** Synthetic taps are an explicit opt-in, independent of the UI perf audit. */
export function isTouchLatencySamplingEnabled(): boolean {
  return parseEnvBoolean(process.env[TOUCH_LATENCY_SAMPLING_ENV]);
}
