import type { TapCoordinatesRequest } from "../observe/shared/SharedGestureDelegate";
import { errorMessage } from "../../utils/describeUnknownError";
import { inputDurationArgument } from "./touchscreenInput";
import {
  resolveCoordinateTapCtrlProxyTimeoutMs,
  resolveGestureCtrlProxyTimeoutMs,
} from "./gestureTransportTimeout";
import { ActionableError, type Point } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { isRunnerGestureOutcomeUnknown } from "../observe/ios/runnerErrorCodes";
import type { IosFrameDispatchOptions } from "../observe/ios/CtrlProxyDispatch";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { TapAnyElementOptions } from "../../models/TapAnyElementOptions";
import type { prepareTargetDisplayAction } from "./TargetDisplayAction";
import { executeTouchscreenInput, supportsCtrlProxyGestureDisplay } from "./touchscreenInput";
import { isStaleFrameContextRejection, LONG_PRESS_MIN_MS } from "./tapAtGesture";
import { dispatchAndroidDoubleTap } from "./androidDoubleTap";
import type { TalkBackTapResult, TalkBackTapStrategy } from "../talkback/TalkBackTapStrategy";
import type { TalkBackNavigationDriver } from "../talkback/TalkBackNavigationDriver";
import { talkBackDisplayRefusal } from "../talkback/talkBackDisplayRefusal";

/** The coordinate-tap subset shared by Android and iOS CtrlProxy clients. */
export interface CoordinateTapClient {
  requestTapCoordinates(
    request: TapCoordinatesRequest,
  ): Promise<{ success: boolean; error?: string }>;
}

/**
 * The iOS client's coordinate-tap subset, including its dispatch outcome metadata.
 * `dispatched`/`acknowledged` follow `sendIOSPressCommand`: a reply from the runner, including a
 * refusal, is acknowledged; a timeout or transport failure after the write is not.
 */
export interface IosCoordinateTapClient {
  requestDoubleTapCoordinates(
    x: number,
    y: number,
    timeoutMs?: number,
    options?: IosFrameDispatchOptions,
  ): ReturnType<IosCoordinateTapClient["requestTapCoordinates"]>;

  requestTapCoordinates(request: TapCoordinatesRequest): Promise<{
    success: boolean;
    error?: string;
    errorCode?: string;
    dispatched?: boolean;
    acknowledged?: boolean;
  }>;
}

export { isStaleFrameContextRejection };

/** A tap that was written to the device but whose outcome was never confirmed. */
export class IndeterminateTapError extends ActionableError {}

/**
 * An element-search debug context re-reads the hierarchy to list near misses. It only explains a
 * target that was not found: after a tap was dispatched the target is known, and the re-read
 * waits behind a runner still executing that tap (15 s of a 20 s `tapOn` in #15296).
 */
export function tapFailureNeedsSearchDebugContext(error: unknown): boolean {
  return !(error instanceof IndeterminateTapError);
}

export function indeterminateTapError(error: string | undefined): ActionableError {
  return new IndeterminateTapError(
    `Tap outcome is indeterminate: the request was dispatched but no result was confirmed (${error ?? "unknown error"}). Do not retry automatically.`,
  );
}

/**
 * Dispatch one Android coordinate tap, preserving TapOnElement's CtrlProxy-first
 * then ADB-fallback behavior for non-element-specific taps.
 */
export interface AndroidCoordinateTapOptions {
  frameContext?: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onTapDelivered?: () => void;
}

export async function dispatchAndroidCoordinateTap(
  accessibilityService: CoordinateTapClient,
  adb: AdbExecutor,
  point: Point,
  { durationMs, options = {} }: { durationMs: number; options?: AndroidCoordinateTapOptions },
): Promise<void> {
  const { x, y } = point;
  const { frameContext, signal, assertCurrent, onTapDelivered } = options;
  throwIfAborted(signal);
  let dispatched = false;
  const onDispatch = () => {
    dispatched = true;
  };
  const timeoutMs = resolveCoordinateTapCtrlProxyTimeoutMs(durationMs);
  const result = await accessibilityService.requestTapCoordinates({
    x,
    y,
    duration: durationMs,
    timeoutMs,
    frameContext,
    onDispatch,
    signal,
    beforeSend: assertCurrent,
  });
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
    {
      signal,
      assertCurrent,
      timeoutMs:
        durationMs >= LONG_PRESS_MIN_MS ? resolveGestureCtrlProxyTimeoutMs(durationMs) : undefined,
    },
  );
  onTapDelivered?.();
  throwIfAborted(signal);
}

export interface IosCoordinateTapOptions {
  failureLabel?: "tap" | "double tap";
  signal?: AbortSignal;
  /** Overrides the transport budget derived from the press duration (tapAny sizes its own). */
  timeoutMs?: number;
}

type InternalIosCoordinateTapOptions = IosCoordinateTapOptions & { doubleTap?: boolean };

/**
 * Dispatch one iOS coordinate tap and preserve CtrlProxy's actionable failure.
 *
 * A tap that was written to the socket but never answered (timeout, socket close, cancellation
 * after the write) may have landed, so it is reported as indeterminate. A tap that was never
 * sent, or that the runner answered with a refusal, stays a plain failure.
 */
export async function dispatchIosCoordinateTap(
  client: IosCoordinateTapClient,
  point: Point,
  {
    durationMs,
    frameContext,
    options = {},
  }: { durationMs: number; frameContext?: string; options?: IosCoordinateTapOptions },
): Promise<void> {
  return dispatchIosTap(client, point, { durationMs, frameContext, options });
}

/** One runner command owns the full double tap; a missing reply proves no partial count. */
export async function dispatchIosDoubleTap(
  client: IosCoordinateTapClient,
  point: Point,
  {
    durationMs = 50,
    frameContext,
    options = {},
  }: { durationMs?: number; frameContext?: string; options?: IosCoordinateTapOptions } = {},
): Promise<void> {
  return dispatchIosTap(client, point, {
    durationMs,
    frameContext,
    options: {
      ...options,
      failureLabel: "double tap",
      doubleTap: true,
    },
  });
}

async function dispatchIosTap(
  client: IosCoordinateTapClient,
  point: Point,
  {
    durationMs,
    frameContext,
    options,
  }: { durationMs: number; frameContext?: string; options: InternalIosCoordinateTapOptions },
): Promise<void> {
  const { x, y } = point;
  const { failureLabel = "tap", signal, doubleTap = false } = options;
  if (doubleTap) {
    throwIfAborted(signal, true);
  }
  const timeoutMs = options.timeoutMs ?? resolveCoordinateTapCtrlProxyTimeoutMs(durationMs);
  let dispatched = false;
  const onDispatch = () => {
    dispatched = true;
  };
  let result: IosTapReply;
  try {
    result = doubleTap
      ? await client.requestDoubleTapCoordinates(x, y, timeoutMs, {
          frameContext,
          signal,
          onDispatch,
        })
      : await client.requestTapCoordinates({
          x,
          y,
          duration: durationMs,
          timeoutMs,
          frameContext,
          signal,
          onDispatch,
        });
  } catch (error) {
    if (isUnconfirmedIosTapThrow(error, dispatched, signal)) {
      logger.warn(`[coordinateTapDispatch] iOS ${failureLabel} transport failed`, error);
      throw indeterminateTapError(errorMessage(error));
    }
    throw error;
  }
  if (result.success) {
    return;
  }
  if (isUnconfirmedIosTapReply(result, dispatched)) {
    // The runner's press is a blocking XCUITest call: the timeout here does not cancel it, so
    // later reads fail with `runner is busy` until it returns. The runner's late
    // `tap_coordinates_result ... lateResponse=true` line names the phase that stalled (#15296).
    logger.warn(
      `[coordinateTapDispatch] iOS ${failureLabel} at (${x}, ${y}) unconfirmed after ${timeoutMs}ms: ` +
        `${result.error ?? "no error"}; the runner may stay busy until its XCUITest gesture returns`,
    );
    throw indeterminateTapError(result.error);
  }
  throw new ActionableError(`CtrlProxy iOS ${failureLabel} failed: ${result.error}`);
}

type IosTapReply = Awaited<ReturnType<IosCoordinateTapClient["requestTapCoordinates"]>>;

/** A runner refusal (an ActionableError) and the caller's own abort keep their original throw. */
function isUnconfirmedIosTapThrow(
  error: unknown,
  dispatched: boolean,
  signal: AbortSignal | undefined,
): boolean {
  return dispatched && !(error instanceof ActionableError) && error !== signal?.reason;
}

/**
 * Written to the socket and not answered, or answered while the runner's gesture was still
 * executing or finished after its deadline (#10016): the tap can still land. A stale-frame
 * refusal proves the tap was rejected.
 */
function isUnconfirmedIosTapReply(result: IosTapReply, dispatched: boolean): boolean {
  if (isRunnerGestureOutcomeUnknown(result)) {
    return true;
  }
  return (
    (result.dispatched ?? dispatched) &&
    result.acknowledged !== true &&
    !isStaleFrameContextRejection(result.error)
  );
}

export interface TalkBackDisplayTapContext {
  strategy: Pick<TalkBackTapStrategy, "executePreciseTap" | "executeCoordinateFallback">;
  driver: TalkBackNavigationDriver;
}

/** Report touches the TalkBack strategy delivered and the warnings it attached. */
function reportTalkBackDelivery(
  result: TalkBackTapResult,
  action: TapAnyElementOptions["action"],
  hooks: { onDispatched: () => void; onWarning?: (warning: string) => void },
): void {
  if (result.success || result.focusCompleted) {
    hooks.onDispatched();
  }
  if (!result.success) {
    return;
  }
  if (action === "doubleTap") {
    // The driver's atomic request delivers both activation touches, so a late
    // cancellation is a completed double tap rather than a partial one.
    hooks.onDispatched();
  }
  // A coordinate gesture the service acknowledged does not confirm semantic activation;
  // surface the same warnings tapAt and the default route report.
  for (const warning of result.warnings ?? []) {
    hooks.onWarning?.(warning);
  }
}

/** TalkBack-on tap on the default display: the strategies the implicit-display routes use. */
function talkBackDisplayTapDispatch(
  options: Pick<TapAnyElementOptions, "action" | "duration">,
  context: {
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    signal?: AbortSignal;
    onDispatched: () => void;
    onWarning?: (warning: string) => void;
    talkBack: TalkBackDisplayTapContext;
  },
): (point: { x: number; y: number }) => Promise<void> {
  const { target, signal, talkBack } = context;
  const fence = {
    assertCurrent: () => {
      throwIfAborted(signal);
      target.assertCurrent();
    },
  };
  return async ({ x, y }) => {
    fence.assertCurrent();
    const action = options.action;
    const durationMs = action === "longPress" ? (options.duration ?? 800) : 50;
    const result =
      action === "tap"
        ? await talkBack.strategy.executePreciseTap(x, y, talkBack.driver, fence)
        : await talkBack.strategy.executeCoordinateFallback(
            { x, y },
            action,
            durationMs,
            talkBack.driver,
            {
              displayFence: fence,
            },
          );
    reportTalkBackDelivery(result, action, context);
    throwIfAborted(signal);
    if (!result.success) {
      throw new ActionableError(
        `TalkBack coordinate tap failed: ${result.error ?? "activation was not confirmed"}${
          result.focusCompleted
            ? " Focus touch was delivered; activation failed. Do not retry automatically."
            : ""
        }`,
      );
    }
  };
}

/** Shared tapOn/tapAny routing; non-default panels require an advertised CtrlProxy capability. */
export async function androidDisplayTapDispatch(
  client: CoordinateTapClient & {
    supportsCommand?: (name: string) => Promise<boolean>;
  },
  adb: AdbExecutor,
  options: Pick<TapAnyElementOptions, "action" | "duration">,
  context: {
    target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>;
    signal?: AbortSignal;
    onDispatched: () => void;
    timer?: Pick<Timer, "sleep" | "now">;
    /** Receives a caution when the sequential fallback starts the taps outside the double-tap window. */
    onWarning?: (warning: string) => void;
    /**
     * Present only when TalkBack is on. A raw coordinate gesture would only move
     * accessibility focus, and the shared driver cannot address a non-default display, so a
     * non-default display is refused before any dispatch (#9905) and the default display
     * uses the same TalkBack coordinate strategies as the implicit-display routes.
     */
    talkBack?: TalkBackDisplayTapContext;
  },
): Promise<(point: { x: number; y: number }) => Promise<void>> {
  const { target, signal, timer = defaultTimer } = context;
  const refusal = context.talkBack ? talkBackDisplayRefusal(target.displayId) : undefined;
  if (refusal) {
    throw refusal;
  }
  if (context.talkBack) {
    return talkBackDisplayTapDispatch(options, { ...context, talkBack: context.talkBack });
  }
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
      const result = await client.requestTapCoordinates({
        x,
        y,
        duration,
        timeoutMs: resolveCoordinateTapCtrlProxyTimeoutMs(duration),
        onDispatch,
        signal,
        displayId: target.displayId === 0 ? undefined : target.displayId,
        beforeSend: target.assertCurrent,
      });
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
      {
        signal,
        assertCurrent: target.assertCurrent,
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
      if (options.action === "doubleTap") {
        await dispatchAndroidDoubleTap({
          // The panel must be routable before a single-gesture double tap may target it.
          client: useCtrlProxy ? client : undefined,
          point,
          displayId: target.displayId === 0 ? undefined : target.displayId,
          timer,
          signal,
          assertCurrent: target.assertCurrent,
          onTapDelivered,
          onWarning: context.onWarning,
          tap: () => dispatch(point, onTapDelivered),
        });
      } else {
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
