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
