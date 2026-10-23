import type { DeviceBaseline } from "./types";

/** Whether the baseline's installed-app inventory lists `appId` (Android `user:N:id`, iOS `id`). */
export function baselineHoldsApp(baseline: DeviceBaseline, appId: string): boolean {
  return baseline.observations.some(
    (entry) =>
      entry.kind === "installed-app" &&
      entry.value.state === "present" &&
      (entry.key === appId || (entry.key.startsWith("user:") && entry.key.endsWith(`:${appId}`))),
  );
}
