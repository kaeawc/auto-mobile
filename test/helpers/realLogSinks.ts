import { afterAll, beforeAll } from "bun:test";
import { testOverrides } from "../../src/utils/testOverrides";

/** Opt into sink assertions for this scope, restoring the shared-process preload default. */
export function useRealLogSinks(): void {
  let previous: typeof testOverrides.logSinksDisabled;
  beforeAll(() => {
    previous = testOverrides.logSinksDisabled;
    testOverrides.logSinksDisabled = undefined;
  });
  afterAll(() => {
    testOverrides.logSinksDisabled = previous;
  });
}
