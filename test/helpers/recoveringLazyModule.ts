import { lazyFeatureModule, type LazyFeatureModule } from "../../src/utils/lazyFeatureModule";

/** The message every failed import in {@link recoveringLazyModule} rejects with. */
export const LAZY_IMPORT_FAILURE = "simulated chunk load failure";

/**
 * A real {@link lazyFeatureModule} whose importer fails until `recover()` is called, so a test
 * drives the production failure path (ActionableError, no memoized rejection) and then the retry.
 */
export interface RecoveringLazyModule<T> {
  readonly module: LazyFeatureModule<T>;
  /** Imports attempted so far, failed ones included. */
  readonly attempts: () => number;
  recover(): void;
}

export function recoveringLazyModule<T>(
  feature: string,
  load: () => T | Promise<T>,
): RecoveringLazyModule<T> {
  let failing = true;
  let attempts = 0;
  const module = lazyFeatureModule(
    feature,
    async () => {
      attempts++;
      if (failing) {
        throw new Error(LAZY_IMPORT_FAILURE);
      }
      return await load();
    },
    { log: { info: () => undefined, warn: () => undefined } },
  );
  return {
    module,
    attempts: () => attempts,
    recover: () => {
      failing = false;
    },
  };
}
