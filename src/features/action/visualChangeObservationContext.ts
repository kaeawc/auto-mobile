import { ObserveResult, type ActiveWindowInfo, type BootedDevice } from "../../models";

import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";

import type { Window } from "../observe/interfaces/Window";
import { DEFAULT_GET_ACTIVE_TIMEOUT_MS } from "../observe/Window";

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

/** Snapshot only the unscoped Android stability path; this never queries the device. */
export function captureStabilityWindow(
  window: Window,
  device: BootedDevice,
  options: ObservedChangeOptions,
): Promise<ActiveWindowInfo | null> | undefined {
  if (device.platform !== "android" || options.skipUiStability || options.display !== undefined) {
    return undefined;
  }
  return window.getCachedActiveWindow();
}

function changedWindowPackage(
  before: ActiveWindowInfo | null | undefined,
  after: ActiveWindowInfo | null | undefined,
): string | undefined {
  if (before === undefined || !after?.appId) {
    return undefined;
  }
  if (before === null) {
    return after.appId;
  }
  const changed =
    before.appId !== after.appId ||
    before.activityName !== after.activityName ||
    before.layoutSeqSum !== after.layoutSeqSum;
  return changed ? after.appId : undefined;
}

/**
 * The post-dispatch window. The cache is free but only moves when the block refreshed this
 * `Window`; an action that declares a foreground change (e.g. Android `OpenURL`, which only fires
 * an intent) without naming its destination gets one bounded fresh read instead (#14447).
 */
async function readPostGestureWindow(
  window: Window,
  options: ObservedChangeOptions,
  before: ActiveWindowInfo | null | undefined,
  timeoutMs: number,
): Promise<ActiveWindowInfo | null | undefined> {
  if (before === undefined || options.display !== undefined) {
    return undefined;
  }
  const cached = await window.getCachedActiveWindow();
  if (
    changedWindowPackage(before, cached) ||
    !options.foregroundAppMayChange ||
    options.packageName
  ) {
    return cached;
  }
  try {
    return await window.getActive(true, options.perf, {
      timeoutMs: Math.min(timeoutMs, DEFAULT_GET_ACTIVE_TIMEOUT_MS),
      signal: options.signal,
    });
  } catch (error) {
    throwIfAborted(options.signal);
    logger.warn(
      `[BaseVisualChange] Post-dispatch active window read failed; using cached window: ${errorMessage(error)}`,
      error,
    );
    return cached;
  }
}

/** A changed post-gesture window wins; otherwise preserve the pre-action package policy. */
export async function resolvePackageName(
  window: Window,
  options: ObservedChangeOptions,
  previous: ObserveResult | null,
  { beforeWindow, timeoutMs }: { beforeWindow?: ActiveWindowInfo | null; timeoutMs: number },
): Promise<string | undefined> {
  const cached = await readPostGestureWindow(window, options, beforeWindow, timeoutMs);
  const destinationPackage = changedWindowPackage(beforeWindow, cached);
  if (destinationPackage) {
    return destinationPackage;
  }
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
  const cachedPackageName = (cached === undefined ? await window.getCachedActiveWindow() : cached)
    ?.appId;
  if (cachedPackageName) {
    logger.info(`[BaseVisualChange] Using cached packageName: ${cachedPackageName}`);
  }
  return cachedPackageName || undefined;
}
