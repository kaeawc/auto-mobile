import { ActionableError } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";

/** The coordinate-tap subset shared by Android and iOS CtrlProxy clients. */
export interface CoordinateTapClient {
  requestTapCoordinates(
    x: number,
    y: number,
    duration?: number,
    timeoutMs?: number,
    perf?: unknown,
    frameContext?: string,
  ): Promise<{ success: boolean; error?: string }>;
}

function isStaleFrameContextRejection(error: string | undefined): boolean {
  return typeof error === "string" && error.toLowerCase().includes("stale frame context");
}

/**
 * Dispatch one Android coordinate tap, preserving TapOnElement's CtrlProxy-first
 * then ADB-fallback behavior for non-element-specific taps.
 */
export async function dispatchAndroidCoordinateTap(
  accessibilityService: CoordinateTapClient,
  adb: AdbExecutor,
  x: number,
  y: number,
  durationMs: number,
  frameContext?: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const result =
    frameContext === undefined
      ? await accessibilityService.requestTapCoordinates(x, y, durationMs)
      : await accessibilityService.requestTapCoordinates(
          x,
          y,
          durationMs,
          undefined,
          undefined,
          frameContext,
        );
  if (result.success) {
    return;
  }
  // A runner that rejected the fresh observation's context proves this point is
  // no longer safe. Do not bypass that verdict through the uncontextualized ADB
  // fallback: the caller must observe again and choose a new point.
  if (frameContext !== undefined && isStaleFrameContextRejection(result.error)) {
    throw new ActionableError(
      result.error ?? "Stale frame context; observe a fresh frame before retrying",
    );
  }
  logger.warn(
    `[TapOnElement] dispatchGesture tap failed (${result.error}), falling back to ADB input`,
  );
  await adb.executeCommand(
    `shell input touchscreen tap ${x} ${y}`,
    undefined,
    undefined,
    undefined,
    signal,
  );
}

/** Dispatch one iOS coordinate tap and preserve CtrlProxy's actionable failure. */
export async function dispatchIosCoordinateTap(
  client: CoordinateTapClient,
  x: number,
  y: number,
  durationMs: number,
  frameContext?: string,
  failureLabel: "tap" | "second tap" = "tap",
): Promise<void> {
  const result =
    frameContext === undefined
      ? await client.requestTapCoordinates(x, y, durationMs)
      : await client.requestTapCoordinates(x, y, durationMs, undefined, undefined, frameContext);
  if (!result.success) {
    throw new ActionableError(`CtrlProxy iOS ${failureLabel} failed: ${result.error}`);
  }
}
