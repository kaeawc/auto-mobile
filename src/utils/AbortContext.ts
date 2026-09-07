import { AsyncLocalStorage } from "node:async_hooks";

type AbortContextState = {
  signal?: AbortSignal;
};

const abortContext = new AsyncLocalStorage<AbortContextState>();

export const combineAbortSignals = (
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined => {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    return undefined;
  }
  return activeSignals.length === 1 ? activeSignals[0] : AbortSignal.any(activeSignals);
};

export const runWithAbortSignal = async <T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> => {
  return abortContext.run({ signal }, fn);
};

export const getAbortSignal = (): AbortSignal | undefined => {
  return abortContext.getStore()?.signal;
};

/**
 * Combine an explicit signal (a forwarded caller signal and/or a private
 * deadline signal) with the ambient request-cancellation signal held in
 * AsyncLocalStorage, so BOTH remain live on the resulting read.
 *
 * This is required at every device-read callsite that passes an explicit
 * `signal` down into {@link AdbClient}: `AdbClient.executeArgsImpl` selects
 * `signal ?? getAbortSignal()`, so handing it ONLY a private deadline (or a
 * forwarded Explore) signal would REPLACE — and therefore DROP — the ambient
 * MCP request signal, silently breaking request cancellation on that read (and
 * on the ADB fallbacks specifically). Passing `combineWithAmbientAbort(signal)`
 * keeps request cancellation working alongside the private deadline.
 *
 * Returns `undefined` when neither an explicit nor an ambient signal exists, so
 * callers can forward the result straight through without a null-guard.
 */
export const combineWithAmbientAbort = (signal?: AbortSignal): AbortSignal | undefined => {
  const ambient = getAbortSignal();
  // Avoid wrapping when the explicit signal already IS the ambient signal, or
  // when only one of the two exists — combineAbortSignals returns the lone
  // signal unwrapped in those cases, which keeps `.aborted` identity checks and
  // reason propagation intact.
  if (signal !== undefined && signal === ambient) {
    return signal;
  }
  return combineAbortSignals(signal, ambient);
};
