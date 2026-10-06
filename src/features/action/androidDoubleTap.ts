import { ActionableError } from "../../models";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { DOUBLE_TAP_GAP_MS, isStaleFrameContextRejection } from "./tapAtGesture";

/** `ViewConfiguration.getDoubleTapTimeout()`: the longest start-to-start gap a double-tap handler accepts. */
export const ANDROID_DOUBLE_TAP_TIMEOUT_MS = 300;

/** Start-to-start budget that leaves margin for dispatch latency inside the 300 ms window. */
export const DOUBLE_TAP_START_BUDGET_MS = 250;

type DoubleTapTimer = Pick<Timer, "sleep" | "now">;

/** Options the single-gesture request forwards to CtrlProxy (frame fence, panel, cancellation). */
export interface AtomicDoubleTapRequestOptions {
  frameContext?: string;
  displayId?: number;
  signal?: AbortSignal;
  beforeSend?: () => void;
}

/**
 * A CtrlProxy client that can perform both taps as one device-timed gesture (`tap_double_v1`).
 * Optional so a client or fake without the method keeps using sequential taps.
 */
export interface AtomicDoubleTapClient {
  requestDoubleTapCoordinates?: (
    x: number,
    y: number,
    onDispatch?: () => void,
    options?: AtomicDoubleTapRequestOptions,
  ) => Promise<{ success: boolean; error?: string; acknowledged?: boolean }>;
}

export function lateSecondTapWarning(startToStartMs: number): string {
  return `The two taps started ${startToStartMs} ms apart, too close to or beyond Android's ${ANDROID_DOUBLE_TAP_TIMEOUT_MS} ms double-tap timeout, so the app may not register a double tap. Update CtrlProxy so the double tap is sent as one device-timed gesture.`;
}

/**
 * Wait until the second tap's DOWN is due, measured from the first tap's START (not its reply),
 * so a slow round trip shortens the sleep instead of stretching the start-to-start interval.
 * A first tap that already outlived the gap is followed immediately; if the second tap still
 * starts outside Android's double-tap timeout the caller is warned instead of silently succeeding.
 */
export async function awaitSecondTapSlot(
  timer: DoubleTapTimer,
  firstTapStartedAt: number,
  context: { signal?: AbortSignal; onWarning?: (warning: string) => void },
): Promise<void> {
  const remainingMs = DOUBLE_TAP_GAP_MS - (timer.now() - firstTapStartedAt);
  if (remainingMs > 0) {
    await awaitWhileRequestIsLive(timer.sleep(remainingMs), context.signal);
  }
  throwIfAborted(context.signal);
  const startToStartMs = timer.now() - firstTapStartedAt;
  if (startToStartMs > DOUBLE_TAP_START_BUDGET_MS) {
    const warning = lateSecondTapWarning(startToStartMs);
    logger.warn(`[doubleTap] ${warning}`);
    context.onWarning?.(warning);
  }
}

/**
 * Send both taps as one CtrlProxy gesture so the device, not host reply latency, sets the
 * start-to-start interval. Resolves `true` when both touches were delivered and `false` when the
 * caller should use sequential taps (unsupported runner or nothing was sent). Once the request
 * reached the device an unconfirmed result is indeterminate and is never retried.
 */
export async function tryAtomicAndroidDoubleTap(
  client: object,
  request: {
    x: number;
    y: number;
    frameContext?: string;
    displayId?: number;
    signal?: AbortSignal;
    assertCurrent?: () => void;
    onTapDelivered?: () => void;
  },
): Promise<boolean> {
  const { signal } = request;
  // Callers hold the shared tap-client interface; only the real Android client has the method.
  const atomic: AtomicDoubleTapClient = client;
  if (typeof atomic.requestDoubleTapCoordinates !== "function") {
    return false;
  }
  throwIfAborted(signal);
  let dispatched = false;
  const result = await atomic.requestDoubleTapCoordinates(
    request.x,
    request.y,
    () => {
      dispatched = true;
    },
    {
      frameContext: request.frameContext,
      displayId: request.displayId,
      signal,
      beforeSend: request.assertCurrent,
    },
  );
  if (result.success) {
    // One accepted request delivers both touches.
    request.onTapDelivered?.();
    request.onTapDelivered?.();
  }
  throwIfAborted(signal);
  if (result.success) {
    return true;
  }
  return rejectOrFallBack(result, { dispatched, frameContext: request.frameContext });
}

/**
 * Classify a failed single-gesture request: throw when sequential taps are unsafe, else fall back.
 * Order matches the single-tap path: a device stale-frame verdict first (it always arrives after
 * the send, and proves nothing was tapped), then dispatched-without-reply, then fall back.
 */
function rejectOrFallBack(
  result: { error?: string; acknowledged?: boolean },
  context: { dispatched: boolean; frameContext?: string },
): false {
  const { error } = result;
  if (context.frameContext !== undefined && isStaleFrameContextRejection(error)) {
    throw new ActionableError(
      error ?? "Stale frame context; observe a fresh frame before retrying",
    );
  }
  if (context.dispatched) {
    // Only a reply proves the device refused the gesture; a timeout, closed socket or missing flag
    // leaves the outcome unknown.
    if (result.acknowledged === true) {
      throw new ActionableError(
        `Double tap was rejected by CtrlProxy: ${error ?? "unknown error"}`,
      );
    }
    throw new ActionableError(
      `Double tap outcome is indeterminate: the gesture was dispatched but no result was confirmed (${error ?? "unknown error"}). Do not retry automatically.`,
    );
  }
  // Nothing reached the device (older runner without tap_double_v1, or not connected), so the
  // sequential path is safe and keeps its own ADB fallback rules.
  logger.debug(
    `[doubleTap] single-gesture double tap not used (${error ?? "unknown error"}); sending two taps`,
  );
  return false;
}

/** Shared entry for paths whose individual taps already carry their own CtrlProxy-then-ADB fallback. */
export async function dispatchAndroidDoubleTap(context: {
  /** Omit when this path must use two plain taps (for example ADB-only recovery). */
  client?: object;
  point: { x: number; y: number };
  frameContext?: string;
  displayId?: number;
  timer: DoubleTapTimer;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onTapDelivered?: () => void;
  onWarning?: (warning: string) => void;
  /** One tap with the caller's own fallback rules; `second` is true for the follow-up tap. */
  tap: (second: boolean) => Promise<void>;
}): Promise<void> {
  const { timer, signal } = context;
  if (
    context.client &&
    (await tryAtomicAndroidDoubleTap(context.client, {
      ...context.point,
      frameContext: context.frameContext,
      displayId: context.displayId,
      signal,
      assertCurrent: context.assertCurrent,
      onTapDelivered: context.onTapDelivered,
    }))
  ) {
    return;
  }
  const firstTapStartedAt = timer.now();
  await context.tap(false);
  await awaitSecondTapSlot(timer, firstTapStartedAt, { signal, onWarning: context.onWarning });
  context.assertCurrent?.();
  await context.tap(true);
}
