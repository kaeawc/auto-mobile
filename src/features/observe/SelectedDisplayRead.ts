import { DisplaySelectionError } from "./DisplaySelection";
import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

export type SelectedDisplayReadFailureKind =
  | "connect-failed"
  | "socket-unavailable"
  | "send-failed"
  | "socket-closed-before-wait"
  | "socket-changed"
  | "socket-disconnected"
  | "timeout"
  | "no-answer"
  | "runner-error"
  | "screen-off"
  | "aborted"
  | "capture-error"
  | "timestamp-floor"
  | "unknown";

export interface SelectedDisplayReadFailure {
  kind: SelectedDisplayReadFailureKind;
  transient: boolean;
}

// CtrlProxyHierarchy currently reports free-form strings. Keep this compatibility
// table in one place until the source emits a typed failure kind.
const failureReasons: readonly (SelectedDisplayReadFailure & { pattern: RegExp })[] = [
  { kind: "runner-error", transient: false, pattern: /runner error:/ },
  {
    kind: "screen-off",
    transient: false,
    pattern: /Screen is off while waiting for hierarchy response/,
  },
  { kind: "capture-error", transient: false, pattern: /Unable to capture hierarchy/ },
  {
    kind: "timestamp-floor",
    transient: false,
    pattern: /Hierarchy capture did not satisfy the device timestamp floor/,
  },
  {
    kind: "connect-failed",
    transient: true,
    pattern: /Failed to establish CtrlProxy WebSocket connection/,
  },
  {
    kind: "socket-unavailable",
    transient: true,
    pattern:
      /Unable to request hierarchy for Android display \d+: CtrlProxy WebSocket is unavailable/,
  },
  {
    kind: "send-failed",
    transient: true,
    pattern: /Unable to request hierarchy for Android display \d+: /,
  },
  {
    kind: "socket-closed-before-wait",
    transient: true,
    pattern: /CtrlProxy WebSocket closed or changed before hierarchy wait/,
  },
  {
    kind: "socket-changed",
    transient: true,
    pattern: /CtrlProxy WebSocket changed while waiting for hierarchy response/,
  },
  {
    kind: "socket-disconnected",
    transient: true,
    pattern: /CtrlProxy WebSocket disconnected while waiting for hierarchy response/,
  },
  {
    kind: "timeout",
    transient: true,
    pattern: /Timed out waiting for hierarchy response after \d+ms/,
  },
  {
    kind: "timeout",
    transient: true,
    pattern: /Device .+ hierarchy read timed out$/,
  },
  {
    kind: "no-answer",
    transient: true,
    pattern: /Hierarchy service did not answer the sync request$/,
  },
  {
    kind: "no-answer",
    transient: true,
    pattern: /[Hh]ierarchy service did not answer$/,
  },
];

export function classifySelectedDisplayReadFailure(
  error: unknown,
  ctx: { signal?: AbortSignal },
): SelectedDisplayReadFailure {
  if (ctx.signal?.aborted) {
    return { kind: "aborted", transient: false };
  }
  const message = errorMessage(error);
  const matched = failureReasons.find(({ pattern }) => pattern.test(message));
  return matched
    ? { kind: matched.kind, transient: matched.transient }
    : { kind: "unknown", transient: false };
}

export class SelectedDisplayReadError extends DisplaySelectionError {
  readonly kind: SelectedDisplayReadFailureKind;
  readonly attempts: number;
  readonly transient = true;

  constructor(
    message: string,
    info: { cause: unknown; kind: SelectedDisplayReadFailureKind; attempts: number },
  ) {
    super(`${message} (after ${info.attempts} attempts)`, { cause: info.cause });
    this.name = "SelectedDisplayReadError";
    this.kind = info.kind;
    this.attempts = info.attempts;
  }
}

export interface SelectedDisplayReadPolicy {
  backoff?: BackoffPolicy;
  maxAttempts?: number;
}

export interface SelectedDisplayReadOptions<T> extends SelectedDisplayReadPolicy {
  read(attempt: { number: number; timeoutMs: number | undefined }): Promise<T>;
  classify(error: unknown): SelectedDisplayReadFailure;
  timer: Timer;
  budgetMs: number;
  /** Preserve the caller's timeout verbatim on attempt one. */
  timeoutMs?: number;
  signal?: AbortSignal;
  assertFenceCurrent(): void;
  wrap(
    error: unknown,
    info: SelectedDisplayReadFailure & { attempts: number; exhausted: boolean },
  ): Error;
}

const defaultBackoff = exponentialBackoff({ initialDelayMs: 200, multiplier: 2, maxDelayMs: 1000 });

function canRetryFailure(failure: SelectedDisplayReadFailure, signal?: AbortSignal): boolean {
  return failure.transient && !signal?.aborted;
}

/** Only the selected-display read retries; input dispatch is never part of this loop. */
export async function readSelectedDisplayWithRetry<T>(
  options: SelectedDisplayReadOptions<T>,
): Promise<T> {
  const { timer, signal } = options;
  const backoff = options.backoff ?? defaultBackoff;
  const maxAttempts = options.maxAttempts ?? 4;
  const deadline = timer.now() + options.budgetMs;
  let attempts = 0;
  while (true) {
    signal?.throwIfAborted();
    attempts++;
    try {
      return await options.read({
        number: attempts,
        timeoutMs: attempts === 1 ? options.timeoutMs : deadline - timer.now(),
      });
    } catch (error) {
      const failure = options.classify(error);
      const info = { ...failure, attempts, exhausted: false };
      if (!canRetryFailure(failure, signal)) {
        throw options.wrap(error, info);
      }
      const delay = backoff.delayForAttempt(attempts);
      const exhausted = () => options.wrap(error, { ...info, exhausted: true });
      if (attempts >= maxAttempts || deadline - timer.now() <= delay) {
        throw exhausted();
      }
      logger.warn(`[SelectedDisplayRead] Retrying ${failure.kind}; attempt ${attempts + 1}`, error);
      await raceWithDeadline(() => timer.sleep(delay), {
        timer,
        signal,
        label: "Selected display read backoff",
      });
      signal?.throwIfAborted();
      options.assertFenceCurrent();
      // A loaded host can resume the backoff later than scheduled.
      if (deadline - timer.now() <= 0) {
        throw exhausted();
      }
    }
  }
}
