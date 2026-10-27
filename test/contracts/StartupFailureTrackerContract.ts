import { describe, expect, test } from "bun:test";
import {
  STARTUP_FAILURE_WINDOW_MS,
  type StartupFailureTracker,
} from "../../src/daemon/DaemonStartupFailureTracker";

export interface StartupFailureTrackerHandle {
  tracker: StartupFailureTracker;
  dispose?: () => Promise<void> | void;
}

/**
 * Shared behavioural contract for {@link StartupFailureTracker} (#11868): the fake and the
 * file-backed DefaultStartupFailureTracker agree on the rolling-window count and on reset.
 */
export function runStartupFailureTrackerContract(
  name: string,
  make: () => Promise<StartupFailureTrackerHandle>,
): void {
  const withTracker = async (body: (tracker: StartupFailureTracker) => void): Promise<void> => {
    const handle = await make();
    try {
      body(handle.tracker);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`StartupFailureTracker contract: ${name}`, () => {
    test("counts failures within the window including the current one", () =>
      withTracker((tracker) => {
        expect(tracker.recordFailure("permanent", 1_000)).toBe(1);
        expect(tracker.recordFailure("transient", 2_000)).toBe(2);
        expect(tracker.recordFailure("permanent", 3_000)).toBe(3);
      }));

    test("failures older than the window fall out of the count", () =>
      withTracker((tracker) => {
        tracker.recordFailure("permanent", 0);
        tracker.recordFailure("permanent", 1_000);
        expect(tracker.recordFailure("permanent", STARTUP_FAILURE_WINDOW_MS + 500)).toBe(2);
      }));

    test("a failure exactly at the window edge still counts", () =>
      withTracker((tracker) => {
        tracker.recordFailure("transient", 0);
        expect(tracker.recordFailure("transient", STARTUP_FAILURE_WINDOW_MS)).toBe(2);
      }));

    test("reset clears the history so counting restarts at one", () =>
      withTracker((tracker) => {
        tracker.recordFailure("permanent", 1_000);
        tracker.recordFailure("permanent", 2_000);
        tracker.reset();
        expect(tracker.recordFailure("permanent", 3_000)).toBe(1);
      }));

    test("reset with no recorded failures is harmless", () =>
      withTracker((tracker) => {
        tracker.reset();
        expect(tracker.recordFailure("transient", 5)).toBe(1);
      }));
  });
}
