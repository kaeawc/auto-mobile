import { describe, expect, test, spyOn } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DeviceCleanupInProgressError,
  DeviceShuttingDownError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { readToolEnvelopePayload } from "../../src/server/toolEnvelopePayload";
import type { BackoffInput } from "../../src/utils/Backoff";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { withProxyOwnerToken } from "../helpers/proxyOwnerToken";
import { drainUntil, settleByFakeEvents } from "../helpers/fakeTimerStepping";

const refusal = (retryAfterMs: number) =>
  shapeToolCallError(new DeviceCleanupInProgressError("emulator-5554", retryAfterMs), {
    toolName: "startDevice",
    source: "MCP",
  });
const shuttingDownRefusal = () =>
  shapeToolCallError(new DeviceShuttingDownError("emulator-5554"), {
    toolName: "startDevice",
    source: "MCP",
  });
const success = { content: [{ type: "text", text: "ok" }] };

async function setup(
  options: {
    capMs?: number;
    settlesAt?: number;
    budgetMs?: number;
    backoff?: BackoffInput;
    shuttingDown?: boolean;
    hint?: number | null;
  } = {},
) {
  const timer = new FakeTimer();
  const pollTimes: number[] = [];
  let lastRefusal: unknown;
  const client = new FakeDaemonClient({
    toolResultFor: () => {
      pollTimes.push(timer.now());
      if (timer.now() >= (options.settlesAt ?? Number.POSITIVE_INFINITY)) {
        return success;
      }
      const remainingCap = (options.capMs ?? 125_000) - timer.now();
      const result = options.shuttingDown
        ? shuttingDownRefusal()
        : refusal(remainingCap > 0 ? remainingCap : 1_000);
      if (options.hint !== undefined) {
        // Exercise unusable wire hints without changing the typed error's defaults.
        const payload = { ...readToolEnvelopePayload(result)!.payload };
        if (options.hint === null) {
          delete payload.retryAfterMs;
        } else {
          payload.retryAfterMs = options.hint;
        }
        lastRefusal = { isError: true, structuredContent: payload };
      } else {
        lastRefusal = result;
      }
      return lastRefusal;
    },
  });
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const proxy = new DaemonMcpProxy({
    clientFactory: () => client,
    daemonManager: manager,
    autoStartDaemon: false,
    timer,
    cleanupWaitBudgetMs: options.budgetMs,
    cleanupWaitBackoff: options.backoff,
  });
  return {
    timer,
    client,
    proxy,
    pollTimes,
    lastRefusal: () => lastRefusal,
    done: async () => {
      isAvailableSpy.mockRestore();
      await proxy.close();
    },
  };
}

async function pendingWait(timer: FakeTimer): Promise<number> {
  await drainUntil(() => timer.getPendingSleepCount() + timer.getPendingTimeoutCount() === 1, {
    description: "cleanup poll wait",
  });
  return timer.getMsUntilNextDueEvent()!;
}

function expectNoWaitTimers(timer: FakeTimer): void {
  expect(timer.getPendingSleepCount()).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
}

describe("DaemonMcpProxy waits out device_cleanup_in_progress (#11900)", () => {
  test("floors repeated 1 ms cleanup hints and ends at the wait budget", async () => {
    const { timer, client, proxy, pollTimes, lastRefusal, done } = await setup({
      hint: 1,
      budgetMs: 1_000,
    });
    try {
      const call = proxy.callTool("getAndroid", {}).catch((error: unknown) => error);
      expect(await pendingWait(timer)).toBeGreaterThanOrEqual(50);
      const result = await settleByFakeEvents(timer, call, {
        maxEvents: 20,
        description: "floored cleanup polls",
      });
      const gaps = pollTimes.slice(1).map((time, i) => time - pollTimes[i]!);
      for (const gap of gaps.slice(0, -1)) {
        expect(gap).toBeGreaterThanOrEqual(50);
      }
      expect(client.callToolCalls.length).toBeLessThanOrEqual(1_000 / 50 + 1);
      expect(timer.now()).toBe(1_000);
      expect(result).toBe(lastRefusal());
      expect(result).toMatchObject({ isError: true });
      expect(readToolEnvelopePayload(result)?.payload.code).toBe("device_cleanup_in_progress");
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });

  test.each([false, true])(
    "floors a fractional hint to a whole-millisecond wait (shuttingDown=%s)",
    async (shuttingDown) => {
      const { timer, proxy, done } = await setup({
        hint: 0.4,
        backoff: shuttingDown ? 0 : 250,
        shuttingDown,
        settlesAt: 50,
      });
      try {
        const call = proxy.callTool("startDevice", {}).catch((error: unknown) => error);
        const delay = await pendingWait(timer);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(50);
        timer.advanceTime(delay);
        await expect(call).resolves.toEqual(success);
        expect(timer.now()).toBe(50);
        expectNoWaitTimers(timer);
      } finally {
        await done();
      }
    },
  );

  test.each([false, true])(
    "floors zero backoff with an unusable hint through the budget (shuttingDown=%s)",
    async (shuttingDown) => {
      const { timer, proxy, pollTimes, lastRefusal, done } = await setup({
        backoff: 0,
        hint: null,
        shuttingDown,
        budgetMs: 125,
      });
      try {
        const call = proxy.callTool("getAndroid", {}).catch((error: unknown) => error);
        expect(await pendingWait(timer)).toBe(50);
        const result = await settleByFakeEvents(timer, call, {
          maxEvents: 3,
          description: "zero backoff cleanup budget",
        });
        expect(pollTimes).toEqual([0, 50, 100, 125]);
        expect(timer.now()).toBe(125);
        expect(result).toBe(lastRefusal());
        expectNoWaitTimers(timer);
      } finally {
        await done();
      }
    },
  );

  test.each([false, true])(
    "rounds fractional steps and budget down without a zero-delay spin (shuttingDown=%s)",
    async (shuttingDown) => {
      const { timer, proxy, pollTimes, lastRefusal, done } = await setup({
        hint: 75.4,
        backoff: { delayForAttempt: () => 75.4 },
        shuttingDown,
        budgetMs: 100.4,
      });
      try {
        const call = proxy.callTool("getAndroid", {}).catch((error: unknown) => error);
        expect(await pendingWait(timer)).toBe(75);
        const result = await settleByFakeEvents(timer, call, {
          maxEvents: 3,
          description: "whole-millisecond cleanup budget",
        });
        expect(pollTimes).toEqual([0, 75, 100]);
        expect(timer.now()).toBe(100);
        expect(result).toBe(lastRefusal());
        expectNoWaitTimers(timer);
      } finally {
        await done();
      }
    },
  );

  test("retries a refused bind on backoff and returns success shortly after early cleanup", async () => {
    const { timer, client, proxy, pollTimes, done } = await setup({ settlesAt: 1_000 });
    try {
      const result = await settleByFakeEvents(timer, proxy.callTool("getAndroid", {}), {
        description: "early cleanup",
      });
      const steps = pollTimes.slice(1).map((time, i) => time - pollTimes[i]!);
      expect(result).toEqual(success);
      expect(timer.now()).toBeGreaterThanOrEqual(1_000);
      expect(timer.now()).toBeLessThanOrEqual(1_000 + Math.max(...steps));
      expect(pollTimes).toEqual([0, 250, 750, 1_750]);
      expect(steps).not.toContain(125_000);
      expect(client.callToolCalls).toHaveLength(4);
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });

  test("clamps each cleanup step down to the remaining advertised cap", async () => {
    const { timer, proxy, pollTimes, done } = await setup({ capMs: 350, settlesAt: 350 });
    try {
      const call = proxy.callTool("startDevice", {}).then(
        (result) => result,
        (error: unknown) => error,
      );
      expect(await pendingWait(timer)).toBe(250);
      timer.advanceTime(250);
      expect(await pendingWait(timer)).toBe(100);
      timer.advanceTime(100);
      await expect(call).resolves.toEqual(success);
      expect(pollTimes).toEqual([0, 250, 350]);
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });

  test("polls at a cap shorter than the first backoff step", async () => {
    const { timer, proxy, done } = await setup({ capMs: 100, settlesAt: 100 });
    try {
      const call = proxy.callTool("startDevice", {}).then(
        (result) => result,
        (error: unknown) => error,
      );
      expect(await pendingWait(timer)).toBe(100);
      timer.advanceTime(100);
      await expect(call).resolves.toEqual(success);
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });

  test("PIN retries a device_shutting_down refusal after its retryAfterMs (#11111)", async () => {
    const { timer, client, proxy, done } = await setup({ shuttingDown: true, settlesAt: 2_000 });
    try {
      const call = proxy.callTool("startDevice", {});
      const delay = await pendingWait(timer);
      expect(delay).toBeGreaterThanOrEqual(2_000);
      timer.advanceTime(delay);
      await expect(call).resolves.toEqual(success);
      expect(client.callToolCalls).toHaveLength(2);
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });

  test("gives up with the last refusal once the budget is spent", async () => {
    const { timer, client, proxy, pollTimes, lastRefusal, done } = await setup({
      capMs: 4_000,
      budgetMs: 6_000,
    });
    try {
      const result = await settleByFakeEvents(timer, proxy.callTool("setActiveDevice", {}), {
        description: "cleanup budget",
      });
      expect(result).toBe(lastRefusal());
      expect(result).toMatchObject({ isError: true });
      expect(readToolEnvelopePayload(result)?.payload.code).toBe("device_cleanup_in_progress");
      expect(timer.now()).toBe(6_000);
      expect(pollTimes).toEqual([0, 250, 750, 1_750, 3_750, 4_000, 5_000, 6_000]);
      const forwards = client.callToolCalls.length;
      expectNoWaitTimers(timer);
      timer.advanceTime(125_000);
      expect(client.callToolCalls).toHaveLength(forwards);
    } finally {
      await done();
    }
  });

  test("clamps every step to a wait deadline shorter than the advertised cap", async () => {
    const { timer, proxy, pollTimes, lastRefusal, done } = await setup({ budgetMs: 2_000 });
    try {
      const result = await settleByFakeEvents(timer, proxy.callTool("getAndroid", {}), {
        description: "short budget",
      });
      expect(result).toBe(lastRefusal());
      expect(timer.now()).toBe(2_000);
      expect(pollTimes).toEqual([0, 250, 750, 1_750, 2_000]);
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });

  test("uses the injected backoff sequence and repeats its final step", async () => {
    const { timer, proxy, pollTimes, done } = await setup({ backoff: [10, 60], settlesAt: 170 });
    try {
      await expect(
        settleByFakeEvents(timer, proxy.callTool("getAndroid", {}), {
          description: "injected backoff",
        }),
      ).resolves.toEqual(success);
      expect(pollTimes).toEqual([0, 50, 110, 170]);
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });

  test("abort mid-wait cancels the timer and never forwards again", async () => {
    const { timer, client, proxy, done } = await setup();
    try {
      const controller = new AbortController();
      const reason = new Error("caller cancelled cleanup wait");
      const call = proxy.callTool("getAndroid", {}, undefined, undefined, controller.signal);
      const rejected = call.then(
        () => {
          throw new Error("Expected caller cancellation");
        },
        (error: unknown) => error,
      );
      await pendingWait(timer);
      controller.abort(reason);
      expect(await rejected).toBe(reason);
      expectNoWaitTimers(timer);
      timer.advanceTime(125_000);
      expect(client.callToolCalls).toHaveLength(1);
    } finally {
      await done();
    }
  });

  test("close mid-wait rejects and cancels the timer", async () => {
    const { timer, client, proxy, done } = await setup();
    try {
      const call = proxy.callTool("getAndroid", {});
      const rejected = call.then(
        () => {
          throw new Error("Expected proxy close cancellation");
        },
        (error: unknown) => error,
      );
      await pendingWait(timer);
      await proxy.close();
      expect(await rejected).toBeInstanceOf(DaemonUnavailableError);
      expectNoWaitTimers(timer);
      timer.advanceTime(125_000);
      expect(client.callToolCalls).toHaveLength(1);
    } finally {
      await done();
    }
  });

  test.each([null, 0, -10, Number.NaN, Number.POSITIVE_INFINITY])(
    "PIN uses ordinary backoff with unusable retry hint %s",
    async (hint) => {
      const { timer, proxy, done } = await setup({ hint, settlesAt: 250 });
      try {
        const call = proxy.callTool("getAndroid", {});
        expect(await pendingWait(timer)).toBe(250);
        timer.advanceTime(250);
        await expect(call).resolves.toEqual(success);
        expectNoWaitTimers(timer);
      } finally {
        await done();
      }
    },
  );

  test("PIN never waits on a non-binding tool that carries the same refusal", async () => {
    const { timer, client, proxy, done } = await setup();
    try {
      await expect(proxy.callTool("tapOn", {})).resolves.toMatchObject({ isError: true });
      expect(client.callToolCalls).toHaveLength(1);
      expect(timer.getSleepCallCount()).toBe(0);
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });

  test("PIN zero wait budget returns the first refusal without scheduling or re-forwarding", async () => {
    const { timer, client, proxy, lastRefusal, done } = await setup({ budgetMs: 0 });
    try {
      const timeoutSpy = spyOn(timer, "setTimeout");
      expect(await proxy.callTool("getAndroid", {})).toBe(lastRefusal());
      expect(client.callToolCalls).toHaveLength(1);
      expect(timer.getSleepCallCount()).toBe(0);
      expect(timeoutSpy).not.toHaveBeenCalled();
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });

  test("PIN re-polls forward caller args unchanged without session-affecting additions", async () => {
    const { timer, client, proxy, done } = await setup({ capMs: 100, settlesAt: 300 });
    try {
      const args = {
        deviceId: "emulator-5554",
        platform: "android",
        name: "Pixel",
        nested: { flag: true },
      };
      await settleByFakeEvents(timer, proxy.callTool("getAndroid", args), {
        description: "unchanged re-poll args",
      });
      expect(client.callToolCalls.length).toBeGreaterThanOrEqual(2);
      const firstAttempt = client.callToolCalls[0]!;
      expect(firstAttempt).toEqual({ toolName: "getAndroid", params: withProxyOwnerToken(args) });
      for (const call of client.callToolCalls) {
        expect(call).toEqual(firstAttempt);
      }
      expectNoWaitTimers(timer);
    } finally {
      await done();
    }
  });
});
