import { describe, expect, spyOn, test } from "bun:test";
import {
  classifySelectedDisplayReadFailure,
  readSelectedDisplayWithRetry,
  SelectedDisplayReadError,
  type SelectedDisplayReadOptions,
} from "../../../src/features/observe/SelectedDisplayRead";
import { DisplaySelectionError } from "../../../src/features/observe/DisplaySelection";
import { FakeTimer } from "../../fakes/FakeTimer";
import { transientFailures, terminalFailures } from "../../helpers/selectedDisplayRead";

const message = (error: unknown) => `Unable to read selected display "inner": ${String(error)}`;
function options<T>(
  read: SelectedDisplayReadOptions<T>["read"],
  timer = new FakeTimer(),
): SelectedDisplayReadOptions<T> {
  timer.enableAutoAdvance();
  return {
    read,
    timer,
    budgetMs: 15000,
    classify: (error) => classifySelectedDisplayReadFailure(error, {}),
    assertFenceCurrent: () => {},
    wrap: (error, info) =>
      info.exhausted
        ? new SelectedDisplayReadError(message(error), {
            cause: error,
            kind: info.kind,
            attempts: info.attempts,
          })
        : new DisplaySelectionError(message(error), { cause: error }),
  };
}

describe("selected-display failure classification", () => {
  test.each([...transientFailures, ...terminalFailures])(
    "classifies %s from direct and wrapped reasons",
    (kind, reason) => {
      for (const error of [
        reason,
        new Error(reason),
        new Error(`Device fake hierarchy service did not answer: ${reason}`),
      ]) {
        expect(classifySelectedDisplayReadFailure(error, {})).toEqual({
          kind,
          transient: transientFailures.some(([name]) => name === kind),
        });
      }
    },
  );
  test.each([
    ["timeout", "Device fake hierarchy read timed out", true],
    ["no-answer", "Device fake hierarchy service did not answer", true],
    ["no-answer", "hierarchy service did not answer", true],
    ["unknown", "Device fake hierarchy service did not answer: novel failure", false],
    ["unknown", "AbortError: cancelled", false],
    ["unknown", "Device fake has no reachable hierarchy service", false],
    ["unknown", undefined, false],
  ] as const)("conservatively classifies %s / %s", (kind, reason, transient) => {
    expect(classifySelectedDisplayReadFailure(reason, {})).toEqual({ kind, transient });
  });
  test.each([
    [
      "Failed to establish CtrlProxy WebSocket connection",
      "connect-failed",
      true,
      "connect-failed",
      true,
      "capture-error",
    ],
    [
      "Unable to request hierarchy for Android display 2: CtrlProxy WebSocket is unavailable",
      "socket-unavailable",
      true,
      "socket-unavailable",
      true,
      "capture-error",
    ],
    [
      "Unable to request hierarchy for Android display 2: send exploded",
      "send-failed",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "CtrlProxy WebSocket closed or changed before hierarchy wait",
      "socket-closed-before-wait",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "CtrlProxy WebSocket disconnected while waiting for hierarchy response",
      "socket-disconnected",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "CtrlProxy WebSocket changed while waiting for hierarchy response",
      "socket-changed",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "Screen is off while waiting for hierarchy response",
      "screen-off",
      false,
      "screen-off",
      false,
      "screen-off",
    ],
    [
      "Timed out waiting for hierarchy response after 100ms",
      "timeout",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "Timed out waiting for hierarchy response after 100ms while retrying",
      "timeout",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "Hierarchy service did not answer the sync request",
      "no-answer",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "runner error: selected panel extraction failed",
      "runner-error",
      false,
      "runner-error",
      false,
      "runner-error",
    ],
    ["hierarchy service did not answer", "no-answer", true, "send-failed", true, "capture-error"],
    [
      "Device emulator-5554 hierarchy service did not answer",
      "no-answer",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "Device emulator-5554 hierarchy read timed out",
      "timeout",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "Device 3f2b8c1e-9a4d-4e57-b6a1-0c5d7e8f9a12 hierarchy service did not answer",
      "no-answer",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "Device 3f2b8c1e-9a4d-4e57-b6a1-0c5d7e8f9a12 hierarchy read timed out",
      "timeout",
      true,
      "send-failed",
      true,
      "capture-error",
    ],
    [
      "Unable to capture hierarchy: malformed nodes",
      "capture-error",
      false,
      "capture-error",
      false,
      "capture-error",
    ],
    [
      "Hierarchy capture did not satisfy the device timestamp floor",
      "timestamp-floor",
      false,
      "timestamp-floor",
      false,
      "capture-error",
    ],
    [
      "CtrlProxy WebSocket is unavailable",
      "unknown",
      false,
      "socket-unavailable",
      true,
      "capture-error",
    ],
    ["send exploded", "unknown", false, "send-failed", true, "capture-error"],
  ] as const)(
    "preserves source and wrapper precedence for %s",
    (reason, kind, transient, requestKind, requestTransient, captureKind) => {
      const cases = [
        [reason, { kind, transient }],
        [`Device X hierarchy service did not answer: ${reason}`, { kind, transient }],
        [
          `Unable to request hierarchy for Android display 2: ${reason}`,
          { kind: requestKind, transient: requestTransient },
        ],
        [`Unable to capture hierarchy: ${reason}`, { kind: captureKind, transient: false }],
      ] as const;
      for (const [message, expected] of cases) {
        for (const error of [message, new Error(message)]) {
          expect(classifySelectedDisplayReadFailure(error, {})).toEqual(expected);
        }
      }
    },
  );

  test.each([
    ["Device fake hierarchy read timed out while retrying", "unknown", false],
    ["Device fake hierarchy read timed out.", "unknown", false],
    ["Device hierarchy read timed out", "timeout", true],
    ["Device  hierarchy read timed out", "timeout", true],
    ["hierarchy read timed out", "timeout", true],
    ["Hierarchy service did not answer.", "unknown", false],
    ["hierarchy service did not answer yet", "unknown", false],
    ["Hierarchy service did not answer the sync request twice", "unknown", false],
    ["Timed out waiting for hierarchy response after ms", "unknown", false],
    ["Timed out waiting for hierarchy response", "unknown", false],
  ] as const)(
    "preserves near-miss classification for %s",
    (reason, deviceKind, deviceTransient) => {
      // The device prefix can supply the leading Device match for an incomplete reason.
      const cases = [
        [reason, { kind: "unknown", transient: false }],
        [
          `Device X hierarchy service did not answer: ${reason}`,
          { kind: deviceKind, transient: deviceTransient },
        ],
        [
          `Unable to request hierarchy for Android display 2: ${reason}`,
          { kind: "send-failed", transient: true },
        ],
        [`Unable to capture hierarchy: ${reason}`, { kind: "capture-error", transient: false }],
      ] as const;
      for (const [message, expected] of cases) {
        for (const error of [message, new Error(message)]) {
          expect(classifySelectedDisplayReadFailure(error, {})).toEqual(expected);
        }
      }
    },
  );

  test("signal state takes priority over all strings", () => {
    const controller = new AbortController();
    controller.abort(new Error("unrelated abort reason"));
    expect(
      classifySelectedDisplayReadFailure(new Error(transientFailures[0][1]), {
        signal: controller.signal,
      }),
    ).toEqual({ kind: "aborted", transient: false });
  });
});

describe("bounded selected-display reads", () => {
  test("default cap is four with canonical exponential delays and last cause", async () => {
    const attempts: { number: number; timeoutMs: number | undefined }[] = [];
    const errors: Error[] = [];
    const opts = options(async (attempt) => {
      attempts.push(attempt);
      const error = new Error(
        `Unable to request hierarchy for Android display 2: send ${attempt.number}`,
      );
      errors.push(error);
      throw error;
    });
    const failure = await readSelectedDisplayWithRetry(opts).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SelectedDisplayReadError);
    expect(failure).toMatchObject({
      kind: "send-failed",
      transient: true,
      attempts: 4,
      cause: errors[3],
      message: `${message(errors[3])} (after 4 attempts)`,
    });
    expect(attempts).toEqual([
      { number: 1, timeoutMs: undefined },
      { number: 2, timeoutMs: 14800 },
      { number: 3, timeoutMs: 14400 },
      { number: 4, timeoutMs: 13600 },
    ]);
    expect((opts.timer as FakeTimer).getSleepHistory()).toEqual([200, 400, 800]);
    expect(opts.timer.now()).toBe(1400);
  });

  test("read time and sleeps share one deadline", async () => {
    const timer = new FakeTimer();
    const timeouts: (number | undefined)[] = [];
    const error = new Error("Device fake hierarchy read timed out");
    const opts = options(async (attempt) => {
      timeouts.push(attempt.timeoutMs);
      timer.advanceTime(100);
      throw error;
    }, timer);
    opts.timeoutMs = 1000;
    opts.budgetMs = 1000;
    const failure = await readSelectedDisplayWithRetry(opts).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      kind: "timeout",
      attempts: 3,
      cause: error,
      message: `${message(error)} (after 3 attempts)`,
    });
    expect(timeouts).toEqual([1000, 700, 200]);
    expect(timer.getSleepHistory()).toEqual([200, 400]);
    expect(timer.now()).toBe(900);
    expect(timer.now()).toBeLessThanOrEqual(opts.budgetMs);
  });

  test("delay equal to remaining budget starts no retry", async () => {
    let calls = 0;
    const opts = options(async () => {
      calls++;
      throw new Error("Device fake hierarchy read timed out");
    });
    opts.budgetMs = 200;
    await expect(readSelectedDisplayWithRetry(opts)).rejects.toMatchObject({
      attempts: 1,
      kind: "timeout",
    });
    expect(calls).toBe(1);
    expect((opts.timer as FakeTimer).getSleepHistory()).toEqual([]);
  });

  test("late backoff wakeup cannot start a read outside the deadline", async () => {
    let calls = 0;
    const timer = new FakeTimer();
    const opts = options(async () => {
      calls++;
      throw new Error("Device fake hierarchy read timed out");
    }, timer);
    opts.budgetMs = 1000;
    const sleep = spyOn(timer, "sleep").mockImplementation(async () => {
      timer.advanceTime(1000);
    });
    try {
      await expect(readSelectedDisplayWithRetry(opts)).rejects.toMatchObject({ attempts: 1 });
      expect(calls).toBe(1);
      expect(timer.now()).toBe(1000);
    } finally {
      sleep.mockRestore();
    }
  });

  test.each(terminalFailures)(
    "%s on attempt two keeps the exact message without suffix",
    async (_kind, reason) => {
      let calls = 0;
      const error = new Error(reason);
      const opts = options(async () => {
        calls++;
        throw calls === 1 ? new Error(transientFailures[0][1]) : error;
      });
      const failure = await readSelectedDisplayWithRetry(opts).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).not.toBeInstanceOf(SelectedDisplayReadError);
      expect(failure).toMatchObject({ cause: error, message: message(error) });
      expect(calls).toBe(2);
    },
  );

  test("abort mid-backoff rejects without advancing the fake clock", async () => {
    const controller = new AbortController();
    const reason = new Error("abort during wait");
    let calls = 0;
    const timer = new FakeTimer();
    const opts = options(async () => {
      calls++;
      throw new Error(transientFailures[0][1]);
    }, timer);
    // A separate manual FakeTimer keeps the backoff pending without real time.
    const manualTimer = new FakeTimer();
    opts.timer = manualTimer;
    opts.signal = controller.signal;
    const result = readSelectedDisplayWithRetry(opts).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      for (let i = 0; i < 8; i++) {
        await Promise.resolve();
      }
      expect(manualTimer.getPendingSleeps()).toEqual([200]);
      controller.abort(reason);
      expect(await result).toBe(reason);
      expect(calls).toBe(1);
      expect(manualTimer.now()).toBe(0);
    } finally {
      manualTimer.reset();
    }
  });

  test("already aborted signals start no read", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    let calls = 0;
    const opts = options(async () => {
      calls++;
      return "unexpected";
    });
    opts.signal = controller.signal;
    await expect(readSelectedDisplayWithRetry(opts)).rejects.toBe(reason);
    expect(calls).toBe(0);
  });
});
