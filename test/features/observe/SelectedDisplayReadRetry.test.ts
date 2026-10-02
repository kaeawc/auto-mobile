import { afterEach, describe, expect, test } from "bun:test";
import { DisplaySelectionError } from "../../../src/features/observe/DisplaySelection";
import { SelectedDisplayReadError } from "../../../src/features/observe/SelectedDisplayRead";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { fixedBackoff } from "../../../src/utils/Backoff";
import {
  readOptions,
  resetSelectedDisplayHarness,
  selectedDisplayDevice,
  selectedDisplayHarness,
  selectedHierarchy,
  terminalFailures,
  transientFailures,
} from "../../helpers/selectedDisplayRead";

afterEach(resetSelectedDisplayHarness);

const failedReadMessage = (error: unknown) =>
  `Unable to read selected display "inner": ${String(error)}`;

describe("selected-display observe retry", () => {
  test.each(transientFailures)(
    "%s retries with the identical routed request",
    async (_kind, reason) => {
      let reads = 0;
      const h = selectedDisplayHarness({
        read: () => {
          reads++;
          if (reads === 1) {
            throw new Error(`Device fake hierarchy service did not answer: ${reason}`);
          }
          return selectedHierarchy();
        },
      });
      const signal = new AbortController().signal;
      const result = await h.screen.execute({
        ...readOptions,
        display: "inner",
        freshness: "cached-ok",
        minTimestamp: 9,
        signal,
      });
      expect(result.viewHierarchy?.frameContext).toBe("second-capture");
      expect(h.capture.requests).toHaveLength(2);
      expect(h.capture.requests[0]).toEqual({
        freshness: "fresh",
        observerMode: false,
        displayId: 2,
        minTimestamp: 9,
        signal,
        timeoutMs: undefined,
      });
      expect(h.capture.requests[1]).toEqual({ ...h.capture.requests[0], timeoutMs: 14800 });
      expect(h.timer.getSleepHistory()).toEqual([200]);
    },
  );

  test.each(terminalFailures)(
    "%s preserves today's exact terminal message",
    async (_kind, reason) => {
      const error = new Error(`Device fake hierarchy service did not answer: ${reason}`);
      const h = selectedDisplayHarness({
        read: () => {
          throw error;
        },
      });
      const failure = await h.screen.execute({ ...readOptions, display: "inner" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DisplaySelectionError);
      expect(failure).not.toBeInstanceOf(SelectedDisplayReadError);
      expect(failure).toMatchObject({ message: failedReadMessage(error), cause: error });
      expect(h.capture.requests).toHaveLength(1);
      expect(h.timer.getSleepHistory()).toEqual([]);
    },
  );

  test("injected cap and backoff preserve caller timeout on attempt one", async () => {
    let reads = 0;
    const errors = [
      new Error("Device fake hierarchy read timed out"),
      new Error("Device fake hierarchy service did not answer"),
    ];
    const h = selectedDisplayHarness({
      selectedDisplayRead: { maxAttempts: 2, backoff: fixedBackoff(25) },
      read: () => {
        throw errors[reads++]!;
      },
    });
    const failure = await h.screen
      .execute({ ...readOptions, display: "inner", timeoutMs: 1000 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SelectedDisplayReadError);
    expect(failure).toMatchObject({
      kind: "no-answer",
      transient: true,
      attempts: 2,
      cause: errors[1],
      message: `${failedReadMessage(errors[1])} (after 2 attempts)`,
    });
    expect(h.capture.requests.map((request) => request.timeoutMs)).toEqual([1000, 975]);
    expect(h.timer.getSleepHistory()).toEqual([25]);
  });

  test("time consumed by failed captures exhausts the original observe budget", async () => {
    const error = new Error("Device fake hierarchy read timed out");
    const h = selectedDisplayHarness({
      read: () => {
        h.timer.advanceTime(100);
        throw error;
      },
    });
    const failure = await h.screen
      .execute({ ...readOptions, display: "inner", timeoutMs: 1000 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SelectedDisplayReadError);
    expect(failure).toMatchObject({
      attempts: 3,
      kind: "timeout",
      transient: true,
      cause: error,
      message: `${failedReadMessage(error)} (after 3 attempts)`,
    });
    expect(h.capture.requests.map((request) => request.timeoutMs)).toEqual([1000, 700, 200]);
    expect(h.timer.getSleepHistory()).toEqual([200, 400]);
    expect(h.timer.now()).toBe(900);
  });

  test("a transition during backoff rejects with the typed stale fence", async () => {
    const h = selectedDisplayHarness({
      read: () => {
        h.timer.setTimeout(
          () => displayTransitions.notifyTransition(selectedDisplayDevice.deviceId, "fold"),
          100,
        );
        throw new Error("Device fake hierarchy read timed out");
      },
    });
    const failure = await h.screen.execute({ ...readOptions, display: "inner" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StaleDisplayError);
    expect(failure).toMatchObject({
      details: { observedGeneration: 0, currentGeneration: 1, retry: "observe" },
    });
    expect(h.capture.requests).toHaveLength(1);
  });

  test("abort during backoff preserves the raw reason through ObserveScreen", async () => {
    const controller = new AbortController();
    const reason = new Error("stop backoff");
    const h = selectedDisplayHarness({
      read: () => {
        h.timer.setTimeout(() => controller.abort(reason), 100);
        throw new Error("Device fake hierarchy read timed out");
      },
    });
    const failure = await h.screen
      .execute({ ...readOptions, display: "inner", signal: controller.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBe(reason);
    expect(h.capture.requests).toHaveLength(1);
  });

  test("a read failing while aborted keeps today's DisplaySelectionError", async () => {
    const controller = new AbortController();
    const error = new Error("Device fake hierarchy read timed out");
    const h = selectedDisplayHarness({
      read: () => {
        controller.abort(new Error("stop read"));
        throw error;
      },
    });
    const failure = await h.screen
      .execute({ ...readOptions, display: "inner", signal: controller.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(DisplaySelectionError);
    expect(failure).toMatchObject({ message: failedReadMessage(error), cause: error });
    expect(h.capture.requests).toHaveLength(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("explicit observer failure keeps its existing display-routing refusal", async () => {
    const h = selectedDisplayHarness({
      read: () => {
        throw new Error("Device fake hierarchy read timed out");
      },
    });
    await expect(
      h.screen.execute({ ...readOptions, observerMode: true, display: "inner" }),
    ).rejects.toThrow(
      "CtrlProxy APK too old for display routing; update it and retry the observation.",
    );
    expect(h.capture.requests).toHaveLength(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test.each([false, true])(
    "default / observer path stays single-read (observer=%s)",
    async (observerMode) => {
      const h = selectedDisplayHarness({
        read: () => {
          throw new Error("Device fake hierarchy read timed out");
        },
      });
      const result = await h.screen.execute({ ...readOptions, observerMode, freshness: "fresh" });
      expect(h.capture.requests).toHaveLength(1);
      expect(h.timer.getSleepHistory()).toEqual([]);
      if (observerMode) {
        expect(result.viewHierarchy?.hierarchy).toMatchObject({
          error: "Hierarchy service unavailable",
          unavailableReason: "connection_lost",
        });
      } else {
        expect(result.viewHierarchy?.frameContext).toBe("second-capture");
      }
    },
  );
});
