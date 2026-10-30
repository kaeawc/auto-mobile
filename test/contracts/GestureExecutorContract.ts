import { describe, expect, test } from "bun:test";
import type { GestureExecutor } from "../../src/features/action/swipeon";

/** What the contract drives: a GestureExecutor plus a way to see and break the "device". */
export interface GestureExecutorContractHarness {
  executor: GestureExecutor;
  /** Swipes that reached the device, in order. */
  dispatchedSwipes(): number;
  /** Make every later swipe fail at the device with `message`. */
  failDevice(message: string): void;
}

/**
 * Shared behavioural contract for the swipe {@link GestureExecutor} (#11868): the fake and the
 * real ADB-backed ExecuteGesture run the same scenarios. The real side runs in the default
 * `adb` scroll mode over a fake ADB executor, so no device or service is involved.
 */
export function runGestureExecutorContract(
  name: string,
  make: () => GestureExecutorContractHarness,
): void {
  describe(`GestureExecutor contract: ${name}`, () => {
    test("a swipe succeeds and echoes the coordinates and requested duration", async () => {
      const { executor, dispatchedSwipes } = make();
      const result = await executor.swipe({ x1: 10, y1: 20, x2: 30, y2: 40 }, { duration: 250 });
      expect(result).toMatchObject({
        success: true,
        x1: 10,
        y1: 20,
        x2: 30,
        y2: 40,
        duration: 250,
      });
      expect(dispatchedSwipes()).toBe(1);
    });

    test("a swipe without a duration reports the 300ms default", async () => {
      const { executor } = make();
      const result = await executor.swipe({ x1: 0, y1: 0, x2: 100, y2: 100 });
      expect(result.success).toBe(true);
      expect(result.duration).toBe(300);
    });

    test("an explicit zero duration is kept, not defaulted", async () => {
      const { executor } = make();
      expect(
        (await executor.swipe({ x1: 0, y1: 0, x2: 100, y2: 100 }, { duration: 0 })).duration,
      ).toBe(0);
    });

    test("a device failure resolves as an unsuccessful result carrying the error", async () => {
      const { executor, failDevice } = make();
      failDevice("device offline");
      const result = await executor.swipe({ x1: 1, y1: 2, x2: 3, y2: 4 }, { duration: 100 });
      expect(result).toMatchObject({ success: false, x1: 1, y1: 2, x2: 3, y2: 4, duration: 100 });
      expect(result.error).toContain("device offline");
    });

    test("an already-aborted signal rejects before anything is dispatched", async () => {
      const { executor, dispatchedSwipes } = make();
      const controller = new AbortController();
      controller.abort();
      await expect(
        executor.swipe(
          { x1: 1, y1: 2, x2: 3, y2: 4 },
          { duration: 100 },
          { signal: controller.signal },
        ),
      ).rejects.toBeDefined();
      expect(dispatchedSwipes()).toBe(0);
    });
  });
}
