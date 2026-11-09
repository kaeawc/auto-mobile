import { toActionableError } from "../models/ActionableError";
import { logger } from "./logger";
import { defaultTimer, type Timer } from "./SystemTimer";

/**
 * A feature-gated module imported on first use, so startup does not parse its chunk (#17709).
 * `load()` imports once and memoizes the module; `loaded()` returns it without waiting once that
 * import has settled, so a caller that must keep its timing synchronous after the first call can.
 */
export interface LazyFeatureModule<T> {
  load(): Promise<T>;
  loaded(): T | undefined;
}

/** Where a feature's first-load latency is reported. */
export interface LazyFeatureLog {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
}

export interface LazyFeatureModuleOptions {
  readonly clock?: Pick<Timer, "now">;
  readonly log?: LazyFeatureLog;
}

/**
 * Memoize `importer` (an `await import(...)` of the feature's module) behind `feature`'s name.
 * The first successful load logs how long the import took; a failed import is not memoized, so
 * the next call retries instead of failing forever.
 */
export function lazyFeatureModule<T>(
  feature: string,
  importer: () => Promise<T>,
  options: LazyFeatureModuleOptions = {},
): LazyFeatureModule<T> {
  const clock = options.clock ?? defaultTimer;
  const log = options.log ?? logger;
  let module: T | undefined;
  let pending: Promise<T> | undefined;
  const importOnce = async (): Promise<T> => {
    const startedAt = clock.now();
    try {
      const imported = await importer();
      module = imported;
      log.info(`[lazy-feature] ${feature} module loaded in ${clock.now() - startedAt} ms`);
      return imported;
    } catch (error) {
      pending = undefined;
      log.warn(`[lazy-feature] ${feature} module failed to load`, error);
      throw toActionableError(error, `Failed to load the ${feature} module`);
    }
  };
  return {
    load: () => {
      if (module !== undefined) {
        return Promise.resolve(module);
      }
      pending ??= importOnce();
      return pending;
    },
    loaded: () => module,
  };
}
