import { describe, expect, test } from "bun:test";
import type { AwaitIdle } from "../../src/features/observe/interfaces/AwaitIdle";

export interface AwaitIdleContractHarness {
  awaitIdle: AwaitIdle;
  /** Makes the device report this rotation. */
  setRotation(rotation: number): void;
}

const abortedSignal = (): AbortSignal => {
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  return controller.signal;
};

/**
 * Shared contract for every {@link AwaitIdle}: the baseline stability state, the
 * rotation wait's success / timeout, and prompt rejection of an already-cancelled
 * request. Run against the real AwaitIdle over a stubbed adb and FakeTimer, and
 * against FakeAwaitIdle so the fake cannot swallow cancellation or pretend a
 * rotation that never happens (issue #11868).
 */
export const runAwaitIdleContract = (
  description: string,
  make: () => AwaitIdleContractHarness,
): void => {
  describe(`AwaitIdle contract: ${description}`, function () {
    test("initial stability state is a clean baseline", async function () {
      const { awaitIdle } = make();

      const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 100);

      expect(state.lastNonIdleTime).toBe(state.startTime);
      expect(state.prevMissedVsync).toBeNull();
      expect(state.prevSlowUiThread).toBeNull();
      expect(state.prevFrameDeadlineMissed).toBeNull();
      expect(state.prevTotalFrames).toBeNull();
      expect(state.firstGfxInfoLog).toBe(true);
    });

    test("resolves a rotation the device already reports", async function () {
      const { awaitIdle, setRotation } = make();
      setRotation(1);

      await expect(awaitIdle.waitForRotation(1, 100)).resolves.toBeUndefined();
    });

    test("rejects with the timeout error when the rotation never arrives", async function () {
      const { awaitIdle, setRotation } = make();
      setRotation(0);

      await expect(awaitIdle.waitForRotation(1, 34)).rejects.toThrow(
        "Timeout waiting for rotation to 1 after 34ms",
      );
    });

    test("rejects an already-cancelled rotation wait", async function () {
      const { awaitIdle, setRotation } = make();
      setRotation(1);

      await expect(awaitIdle.waitForRotation(1, 100, abortedSignal())).rejects.toThrow();
    });

    test("rejects an already-cancelled stability initialization", async function () {
      const { awaitIdle } = make();

      await expect(
        awaitIdle.initializeUiStabilityTracking("com.example.app", 100, abortedSignal()),
      ).rejects.toThrow();
    });

    test("rejects an already-cancelled stability wait", async function () {
      const { awaitIdle } = make();

      await expect(
        awaitIdle.waitForUiStability("com.example.app", 100, undefined, abortedSignal()),
      ).rejects.toThrow();
    });

    test("rejects an already-cancelled stability wait with prior state", async function () {
      const { awaitIdle } = make();
      const state = await awaitIdle.initializeUiStabilityTracking("com.example.app", 100);

      await expect(
        awaitIdle.waitForUiStabilityWithState(
          "com.example.app",
          100,
          state,
          undefined,
          abortedSignal(),
        ),
      ).rejects.toThrow();
    });
  });
};
