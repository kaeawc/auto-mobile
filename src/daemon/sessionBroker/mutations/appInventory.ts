import { logger } from "../../../utils/logger";
import type { DeviceBaseline, DeviceMutationInput } from "./types";

/** Whether the baseline's installed-app inventory lists `appId` (Android `user:N:id`, iOS `id`). */
export function baselineHoldsApp(baseline: DeviceBaseline, appId: string): boolean {
  return baseline.observations.some(
    (entry) =>
      entry.kind === "installed-app" &&
      entry.value.state === "present" &&
      (entry.key === appId || (entry.key.startsWith("user:") && entry.key.endsWith(`:${appId}`))),
  );
}

export const APP_INTERACTION_BREADCRUMB_KEYS = [
  "tool:setUIState",
  "focused-field",
] as readonly string[];

/** App-owned store keys encode their owner structurally; malformed keys cannot prove coverage. */
export function storeAppId(key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    return typeof parsed === "object" &&
      parsed !== null &&
      "appId" in parsed &&
      typeof parsed.appId === "string" &&
      parsed.appId.length > 0
      ? parsed.appId
      : undefined;
  } catch (error) {
    logger.warn("App-state journal key is unreadable; baseline fallback required", error);
    return undefined;
  }
}

/** Uninstall covers session-app stores; app-owned breadcrumbs make no store claim. */
export function storePreferenceCoveredByBaseline(
  entry: DeviceMutationInput,
  baseline: DeviceBaseline | null | undefined,
): boolean {
  if (APP_INTERACTION_BREADCRUMB_KEYS.includes(entry.key)) {
    return true;
  }
  const appId = storeAppId(entry.key);
  return !!appId && !!baseline && !baselineHoldsApp(baseline, appId);
}
