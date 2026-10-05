import { errorMessage } from "../../utils/describeUnknownError";
import { inputDurationArgument } from "./touchscreenInput";
import {
  resolveCoordinateTapCtrlProxyTimeoutMs,
  resolveGestureCtrlProxyTimeoutMs,
} from "./gestureTransportTimeout";
import { ActionableError } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { TapAnyElementOptions } from "../../models/TapAnyElementOptions";
import type { prepareTargetDisplayAction } from "./TargetDisplayAction";
import { executeTouchscreenInput, supportsCtrlProxyGestureDisplay } from "./touchscreenInput";
import { DOUBLE_TAP_GAP_MS, LONG_PRESS_MIN_MS } from "./tapAtGesture";

/** The coordinate-tap subset shared by Android and iOS CtrlProxy clients. */
export interface CoordinateTapClient<Dispatch = never> {
  requestTapCoordinates(
    x: number,
    y: number,
    duration?: number,
    timeoutMs?: number,
    perf?: unknown,
    frameContext?: string,
    onDispatch?: Dispatch,
    signal?: AbortSignal,
    displayId?: number,
    beforeSend?: () => void,
  ): Promise<{ success: boolean; error?: string }>;
}

export function isStaleFrameContextRejection(error: string | undefined): boolean {
  return typeof error === "string" && error.toLowerCase().includes("stale frame context");
}

export function indeterminateTapError(error: string | undefined): ActionableError {
  return new ActionableError(
    `Tap outcome is indeterminate: the request was dispatched but no result was confirmed (${error ?? "unknown error"}). Do not retry automatically.`,
  );
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
  assertCurrent?: () => void,
  onTapDelivered?: () => void,
): Promise<void> {
  throwIfAborted(signal);
  let dispatched = false;
  const onDispatch = () => {
    dispatched = true;
  };
  // TapAtCoordinate stores both platform clients under the shared interface.
  // Only the Android client accepts a dispatch callback in position seven;
  // the iOS client uses that position for an abort signal.
  const androidService = accessibilityService as CoordinateTapClient<() => void>;
  const timeoutMs = resolveCoordinateTapCtrlProxyTimeoutMs(durationMs);
  const result =
    frameContext === undefined
      ? await androidService.requestTapCoordinates(
          x,
          y,
          durationMs,
          timeoutMs,
          undefined,
          undefined,
          onDispatch,
          signal,
          undefined,
          assertCurrent,
        )
      : await androidService.requestTapCoordinates(
          x,
          y,
          durationMs,
          timeoutMs,
          undefined,
          frameContext,
          onDispatch,
          signal,
          undefined,
          assertCurrent,
        );
  if (result.success) {
    onTapDelivered?.();
  }
  throwIfAborted(signal);
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
  if (dispatched) {
    throw indeterminateTapError(result.error);
  }
  logger.warn(
    `[TapOnElement] dispatchGesture tap failed (${result.error}), falling back to ADB input`,
  );
  await executeTouchscreenInput(
    adb,
    durationMs >= LONG_PRESS_MIN_MS
      ? `swipe ${x} ${y} ${x} ${y} ${inputDurationArgument(durationMs)}`
      : `tap ${x} ${y}`,
    undefined,
    signal,
    assertCurrent,
    {
      timeoutMs:
        durationMs >= LONG_PRESS_MIN_MS ? resolveGestureCtrlProxyTimeoutMs(durationMs) : undefined,
    },
  );
  onTapDelivered?.();
  throwIfAborted(signal);
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
  const timeoutMs = resolveCoordinateTapCtrlProxyTimeoutMs(durationMs);
  const result =
    frameContext === undefined
      ? await client.requestTapCoordinates(x, y, durationMs, timeoutMs)
      : await client.requestTapCoordinates(x, y, durationMs, timeoutMs, undefined, frameContext);
  if (!result.success) {
    throw new ActionableError(`CtrlProxy iOS ${failureLabel} failed: ${result.error}`);
  }
}

/** Shared tapOn/tapAny routing; non-default panels require an advertised CtrlProxy capability. */
export async function androidDisplayTapDispatch(
  client: CoordinateTapClient<() => void> & {
    supportsCommand?: (name: string) => Promise<boolean>;
  },
  adb: AdbExecutor,
  options: Pick<TapAnyElementOptions, "action" | "duration">,
  context: {
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    signal?: AbortSignal;
    onDispatched: () => void;
    timer?: Pick<Timer, "sleep">;
  },
): Promise<(point: { x: number; y: number }) => Promise<void>> {
  const { target, signal, timer = defaultTimer } = context;
  const useCtrlProxy = await supportsCtrlProxyGestureDisplay(client, target.displayId);
  const dispatch = async ({ x, y }: { x: number; y: number }, onTapDelivered: () => void) => {
    throwIfAborted(signal);
    target.assertCurrent();
    const duration = options.action === "longPress" ? (options.duration ?? 800) : 10;
    if (useCtrlProxy) {
      let dispatched = false;
      const onDispatch = () => {
        dispatched = true;
      };
      const result = await client.requestTapCoordinates(
        x,
        y,
        duration,
        resolveCoordinateTapCtrlProxyTimeoutMs(duration),
        undefined,
        undefined,
        onDispatch,
        signal,
        target.displayId === 0 ? undefined : target.displayId,
        target.assertCurrent,
      );
      if (result.success) {
        onTapDelivered();
      }
      throwIfAborted(signal);
      if (result.success) {
        return;
      }
      if (dispatched) {
        throw indeterminateTapError(result.error);
      }
      if (isStaleFrameContextRejection(result.error)) {
        throw new ActionableError(result.error ?? "Stale frame context");
      }
      logger.warn(
        `[androidDisplayTapDispatch] dispatchGesture tap failed (${result.error}), falling back to ADB input`,
      );
    }
    await executeTouchscreenInput(
      adb,
      options.action === "longPress"
        ? `swipe ${x} ${y} ${x} ${y} ${inputDurationArgument(duration)}`
        : `tap ${x} ${y}`,
      target.displayId,
      signal,
      target.assertCurrent,
      {
        timeoutMs:
          options.action === "longPress" ? resolveGestureCtrlProxyTimeoutMs(duration) : undefined,
      },
    );
    onTapDelivered();
    throwIfAborted(signal);
  };
  return async (point) => {
    let tapsDelivered = 0;
    const onTapDelivered = () => {
      tapsDelivered++;
      context.onDispatched();
    };
    try {
      await dispatch(point, onTapDelivered);
      if (options.action === "doubleTap") {
        await awaitWhileRequestIsLive(timer.sleep(DOUBLE_TAP_GAP_MS), signal);
        throwIfAborted(signal);
        target.assertCurrent();
        await dispatch(point, onTapDelivered);
      }
    } catch (error) {
      if (options.action === "doubleTap" && tapsDelivered === 1) {
        throw indeterminateTapError(
          `${errorMessage(error)}. Double tap partially applied: one tap was delivered; the second tap was not confirmed`,
        );
      }
      throw error;
    }
  };
}
