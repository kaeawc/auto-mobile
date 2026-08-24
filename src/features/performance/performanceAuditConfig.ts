import { serverConfig } from "../../utils/ServerConfig";
import { isDebugPerfEnabled } from "../../utils/PerformanceTracker";

const DISABLE_PERF_AUDIT_ENV = "AUTOMOBILE_DISABLE_PERF_AUDIT";

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
