import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TimerManagedConnectionRebind } from "../../../src/daemon/managedSlots/managedConnectionRebind";
import { DAEMON_SHUTTING_DOWN_ERROR_CODE } from "../../../src/daemon/constants";
import { DaemonShuttingDownError } from "../../../src/daemon/client";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const refusal = (retryable?: boolean, retryAfterMs?: number) =>
  Object.assign(new Error("not rehydrated"), { retryable, retryAfterMs });

function harness(failures: unknown[] = []) {
  const timer = new FakeTimer();
  const driver = new TimerManagedConnectionRebind(timer);
  const calls: number[] = [];
  let wanted = true;
  const attempts = {
    stillWanted: () => wanted,
    describe: () => "scope-a sessions session-a, session-b",
    attempt: async () => {
      calls.push(timer.now());
      if (failures.length > 0) {
        throw failures.shift();
      }
    },
  };
  return {
    timer,
    driver,
    calls,
    attempts,
    stop: () => {
      wanted = false;
    },
    advance: (ms: number) => timer.advanceTimeAsync(ms, () => drainMicrotasks(10)),
  };
}

let logSpies: Array<ReturnType<typeof spyOn>> = [];
afterEach(() => {
  for (const spy of logSpies) {
    spy.mockRestore();
  }
  logSpies = [];
});

describe("managed connection re-bind retry", () => {
  test("grows waits to the cap until success without warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    logSpies = [warn, debug];
    const info = spyOn(logger, "info").mockImplementation(() => {});
    logSpies.push(info);
    const h = harness(Array.from({ length: 6 }, () => refusal(true)));
    h.driver.start(h.attempts, refusal(true));
    await h.advance(50 + 100 + 200 + 400 + 800 + 1_000 + 1_000);
    expect(h.calls).toEqual([50, 150, 350, 750, 1_550, 2_550, 3_550]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(6);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain("3550 ms");
    expect(info.mock.calls[0]?.[0]).toContain("8 attempts");
  });

  test("uses the greater of daemon minimum and exponential backoff", async () => {
    const h = harness([refusal(true, 100)]);
    h.driver.start(h.attempts, refusal(true, 900));
    await h.advance(1_000);
    expect(h.calls).toEqual([900, 1_000]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["initial", "retry"])("stops on a terminal %s refusal", async (phase) => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    logSpies = [warn];
    const h = harness([refusal(false)]);
    h.driver.start(h.attempts, refusal(phase === "initial" ? false : true));
    await h.advance(10_000);
    expect(h.calls).toHaveLength(phase === "initial" ? 0 : 1);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("refused permanently");
    expect(warn.mock.calls[0][0]).toContain("socket stays confined");
    expect(warn.mock.calls[0][0]).toContain("not rehydrated");
  });

  test("missing code (transport or timeout) still retries", async () => {
    const h = harness([new Error("transport")]);
    h.driver.start(h.attempts, new Error("timeout"));
    await h.advance(150);
    expect(h.calls).toEqual([50, 150]);
  });

  test("stops when the execution or socket is no longer wanted", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    logSpies = [warn];
    const h = harness();
    h.driver.start(h.attempts, refusal(true));
    h.stop();
    await h.advance(50);
    expect(h.calls).toEqual([]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["initial", "retry"])(
    "a coded %s refusal without retry intent stops",
    async (phase) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      logSpies = [warn];
      const coded = Object.assign(new Error("older daemon refusal"), { code: "managed_refusal" });
      const h = harness([coded]);
      h.driver.start(h.attempts, phase === "initial" ? coded : refusal(true));
      await h.advance(10_000);
      expect(h.calls).toHaveLength(phase === "initial" ? 0 : 1);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("refused permanently");
      expect(warn.mock.calls[0][0]).toContain("older daemon refusal");
    },
  );

  test("explicit retry intent on a coded refusal retries until success", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    logSpies = [warn];
    const h = harness();
    h.driver.start(h.attempts, Object.assign(refusal(true), { code: "managed_refusal" }));
    await h.advance(50);
    expect(h.calls).toEqual([50]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a permanent failure after the socket is unwanted stops without warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    logSpies = [warn];
    const h = harness();
    h.stop();
    h.driver.start(h.attempts, refusal(false));
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("cancel clears the pending timer", async () => {
    const h = harness();
    h.driver.start(h.attempts, refusal(true));
    h.driver.cancel();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    await h.advance(10_000);
    expect(h.calls).toEqual([]);
  });

  test("a second start cannot create another chain, including while an attempt is in flight", async () => {
    const h = harness();
    const pending = Promise.withResolvers<void>();
    let calls = 0;
    const attempts = {
      stillWanted: () => true,
      attempt: () => {
        calls++;
        return pending.promise;
      },
    };
    h.driver.start(attempts, refusal(true));
    h.driver.start(attempts, refusal(true));
    expect(h.timer.getPendingTimeoutCount()).toBe(1);
    await h.advance(50);
    h.driver.start(attempts, refusal(true));
    expect(calls).toBe(1);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    pending.resolve();
    await drainMicrotasks(10);
  });

  test("cancelling an in-flight attempt prevents its failure from scheduling again", async () => {
    const h = harness();
    const pending = Promise.withResolvers<void>();
    h.driver.start({ stillWanted: () => true, attempt: () => pending.promise }, refusal(true));
    await h.advance(50);
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    logSpies.push(debug);
    h.driver.cancel();
    pending.reject(refusal(true));
    await drainMicrotasks(10);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(debug).not.toHaveBeenCalled();
  });
});

test("one transient failure binds at 50 ms with one info and no warn", async () => {
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  logSpies = [info, warn];
  const h = harness();
  h.driver.start(h.attempts, refusal(true));
  await h.advance(49);
  expect(h.calls).toEqual([]);
  await h.advance(1);
  expect(h.calls).toEqual([50]);
  expect(info).toHaveBeenCalledTimes(1);
  expect(info.mock.calls[0]?.[0]).toContain("50 ms");
  expect(info.mock.calls[0]?.[0]).toContain("2 attempts");
  expect(warn).not.toHaveBeenCalled();
});

test("three seconds of refusal binds within one second of clearing", async () => {
  const h = harness(Array.from({ length: 6 }, () => refusal(true)));
  h.driver.start(h.attempts, refusal(true));
  await h.advance(4_000);
  expect(h.calls.at(-1)).toBe(3_550);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("persistent refusal retries every second and warns once only after sixty seconds", async () => {
  const h = harness(Array.from({ length: 100 }, () => refusal(true)));
  const warnedAt: number[] = [];
  const warn = spyOn(logger, "warn").mockImplementation(() => {
    warnedAt.push(h.timer.now());
  });
  logSpies = [warn];
  h.driver.start(h.attempts, refusal(true));
  await h.advance(60_000);
  expect(warn).not.toHaveBeenCalled();
  await h.advance(4_000);
  expect(h.calls).toEqual([
    50,
    150,
    350,
    750,
    1_550,
    ...Array.from({ length: 62 }, (_, i) => 2_550 + i * 1_000),
  ]);
  expect(warnedAt).toEqual([60_550]);
  const message = warn.mock.calls[0]?.[0];
  for (const value of [
    "session-a",
    "session-b",
    "scope-a",
    "60550 ms",
    "65 attempts",
    "not rehydrated",
  ]) {
    expect(message).toContain(value);
  }
  h.driver.cancel();
});

test.each([500, 2_000])("honours a %s ms hint even above the cap", async (hint) => {
  const h = harness(Array.from({ length: 7 }, () => refusal(true, hint)));
  h.driver.start(h.attempts, refusal(true, hint));
  await h.advance(hint === 500 ? 4_800 : 16_000);
  expect(h.calls).toEqual(
    hint === 500
      ? [500, 1_000, 1_500, 2_000, 2_800, 3_800, 4_800]
      : [2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 14_000, 16_000],
  );
  h.driver.cancel();
});

test.each(["coded", "typed"])("shutdown %s answer stops quietly", async (kind) => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  logSpies = [warn];
  const h = harness();
  const error =
    kind === "typed"
      ? new DaemonShuttingDownError()
      : Object.assign(new Error("shutdown"), {
          code: DAEMON_SHUTTING_DOWN_ERROR_CODE,
          retryable: false,
        });
  h.driver.start(h.attempts, error);
  await h.advance(2_000);
  expect(h.calls).toEqual([]);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
  expect(warn).not.toHaveBeenCalled();
});

test.each([true, false])("replaces an old socket chain (old still wanted=%s)", async (wanted) => {
  const h = harness();
  h.driver.start(h.attempts, refusal(true));
  if (!wanted) {
    h.stop();
  }
  const calls: number[] = [];
  const next = {
    stillWanted: () => true,
    attempt: async () => {
      calls.push(h.timer.now());
    },
  };
  h.driver.start(next, refusal(true));
  h.driver.start(next, refusal(true));
  await h.advance(50);
  expect(h.calls).toEqual([]);
  expect(calls).toEqual([50]);
});
