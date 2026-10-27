import { type LogStream } from "./loggingConfig";
import { Timer, defaultTimer } from "./SystemTimer";
import { toActionableError } from "../models/ActionableError";

type EndableLogStream = Pick<LogStream, "end" | "once" | "off" | "closed" | "destroy">;

// Bounds how long closeLogStream() waits for the confirming `close`, including
// a stream that silently never closes. A stuck fd must not hold the next test
// file's logger teardown (or production shutdown) indefinitely.
export const CLOSE_LOG_STREAM_TIMEOUT_MS = 5_000;

/**
 * Resolves once a log stream has ACTUALLY closed (its file descriptor
 * released), or rejects if closing it failed.
 *
 * `WriteStream.end(callback)` fires its callback on writable completion — the
 * same moment as the `finish` event — but the underlying fd is only released
 * later, on the `close` event. On Bun (and Node) the observed order is: end
 * callback, then `finish`, then `close`. Reopening the same path on the earlier
 * `finish` signal therefore still races bun's epoll registration for the not-
 * yet-released fd and can throw `EEXIST: ... epoll_ctl` on the replacement
 * stream's construction — the exact race rotation exists to avoid (issue
 * #6149). So we drive `end()` to start the shutdown but wait for `close`.
 *
 * Two more orderings, both confirmed on Node 24 and Bun 1.2.14:
 *  - An `error` during shutdown (e.g. a failing fd, `/dev/full`) does NOT mean
 *    the fd was released — `close` still follows. Settling on `error` alone
 *    let the caller rename/reopen the path while the old descriptor was still
 *    live, recreating the exact race this function exists to avoid. The error
 *    is recorded and still surfaced (so the failure is not silently lost) but
 *    only once the confirming `close` actually arrives.
 *  - A stream whose fd was already released before this call (e.g. a repeated
 *    `logger.close()` / `closeAfterFlush()`) never emits a second `close` —
 *    Node/Bun only fire it once per stream — so waiting for a listener would
 *    hang forever. Check `closed` up front and resolve immediately.
 *
 * Bounded close policy (issue #6700): the ordering above is the observed
 * contract on the runtimes this was verified against, not a guarantee the
 * platform makes. If a supported runtime (or an already-broken stream) emits
 * `error` and then never emits `close`, this must not hang the caller
 * forever. So once an `error` is observed, this (a) explicitly `destroy()`s
 * the stream if it exposes that method, nudging a stalled fd toward release,
 * and (b) keeps a bounded timer. The `close` listener stays authoritative —
 * a `close` that arrives before the bound (whether from the normal shutdown
 * or as a result of the `destroy()` call) still settles exactly as before,
 * rejecting with the recorded error. Only if `close` never arrives within
 * `timeoutMs` does this reject with an actionable timeout instead of hanging.
 * The timer is armed even without an error, for a stream that emits neither
 * `error` nor `close`. Deliberately does NOT settle immediately on `error` alone — that would
 * recreate the fd race fixed by #6149.
 */
export function closeLogStream(
  stream: EndableLogStream,
  timer: Timer = defaultTimer,
  timeoutMs: number = CLOSE_LOG_STREAM_TIMEOUT_MS,
): Promise<void> {
  if (stream.closed) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let pendingError: Error | undefined;
    const timeoutHandle = timer.setTimeout(() => {
      settle(() => {
        stream.destroy?.();
        reject(
          toActionableError(
            pendingError ?? new Error("Log stream close stalled"),
            `Log stream did not emit 'close' within ${timeoutMs}ms — the file descriptor may still be held`,
          ),
        );
      });
    }, timeoutMs);
    const settle = (run: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      stream.off("error", onError);
      stream.off("close", onClose);
      timer.clearTimeout(timeoutHandle);
      run();
    };
    // Do NOT settle here — only record the error and keep waiting for the
    // `close` that confirms the fd is actually released. Do arm the bounded
    // fallback below so an error that is never followed by `close` cannot
    // hang this promise forever.
    const onError = (error: Error): void => {
      pendingError = error;
      // Let every listener record the error before a synchronous destroy can
      // emit close (concurrent close callers may share this stream).
      queueMicrotask(() => {
        if (!settled) {
          stream.destroy?.(error);
        }
      });
    };
    const onClose = (): void => settle(() => (pendingError ? reject(pendingError) : resolve()));
    stream.once("error", onError);
    stream.once("close", onClose);
    // Start the shutdown; the `close` listener above (not end()'s finish-time
    // callback, and not a same-tick `error`) is what actually resolves this
    // promise once the fd is released.
    stream.end();
  });
}

export type LogSinkTimer = Pick<Timer, "setTimeout" | "clearTimeout" | "now">;

// The logger is process infrastructure: its watchdog must not enter the timer
// history of code whose tests assert no real timers, even under later spies.
const runtimeSetTimeout = globalThis.setTimeout;

const runtimeClearTimeout = globalThis.clearTimeout;

const runtimeNow = Date.now;

export const productionStallTimer = {
  setTimeout: (callback: () => void, ms: number) => runtimeSetTimeout(callback, ms),
  clearTimeout: (handle: NodeJS.Timeout) => runtimeClearTimeout(handle),
  now: () => runtimeNow(),
};
