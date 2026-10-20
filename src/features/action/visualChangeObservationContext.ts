import { ObserveResult } from "../../models";

import { logger } from "../../utils/logger";

import type { Window } from "../observe/interfaces/Window";

import type { ObservedChangeOptions } from "./observedInteractionTypes";

export function resolveObservationStartTime(
  options: ObservedChangeOptions,
  actionStartTime: number,
  clockSkewMs: number,
): number {
  const hostTimestamp = options.observationHostTimestampProvider?.();
  const override =
    options.observationTimestampProvider?.() ??
    (typeof hostTimestamp === "number" ? hostTimestamp + clockSkewMs : undefined);
  if (typeof override !== "number" || Number.isNaN(override)) {
    return actionStartTime;
  }
  if (override >= actionStartTime) {
    logger.debug(`[BaseVisualChange] Using observation timestamp override: ${override}`);
    return override;
  }
  logger.debug(
    `[BaseVisualChange] Ignoring observation timestamp override (${override}) older than action start (${actionStartTime})`,
  );
  return actionStartTime;
}

/** Package name for UI stability waiting: options, then the pre-read hierarchy, then cache. */
export async function resolvePackageName(
  window: Window,
  options: ObservedChangeOptions,
  previous: ObserveResult | null,
): Promise<string | undefined> {
  if (options.packageName) {
    return options.packageName;
  }
  const fromHierarchy = previous?.viewHierarchy?.packageName;
  if (fromHierarchy) {
    logger.info(`[BaseVisualChange] Using packageName from view hierarchy: ${fromHierarchy}`);
    return fromHierarchy;
  }
  if (options.display !== undefined) {
    return undefined;
  }
  const cachedPackageName = (await window.getCachedActiveWindow())?.appId;
  if (cachedPackageName) {
    logger.info(`[BaseVisualChange] Using cached packageName: ${cachedPackageName}`);
  }
  return cachedPackageName || undefined;
}
