import { describe, expect, test, spyOn } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DeviceCleanupInProgressError,
  DeviceShuttingDownError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";

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

async function setup(options: {
  refusals: number;
  retryAfterMs: number;
  budgetMs?: number;
  shuttingDown?: boolean;
}) {
  const timer = new FakeTimer();
  let remaining = options.refusals;
  const client = new FakeDaemonClient({
    toolResultFor: () =>
      remaining-- > 0
        ? options.shuttingDown
          ? shuttingDownRefusal()
          : refusal(options.retryAfterMs)
        : success,
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
  });
  return {
    timer,
    client,
    proxy,
    done: async () => {
      isAvailableSpy.mockRestore();
      await proxy.close();
    },
  };
}

describe("DaemonMcpProxy waits out device_cleanup_in_progress (#10960)", () => {
  test("retries a refused bind after retryAfterMs and returns the later success", async () => {
    const { timer, client, proxy, done } = await setup({ refusals: 2, retryAfterMs: 4_000 });
    try {
      const call = proxy.callTool("startDevice", {});
      await drainUntil(() => timer.getPendingSleepCount() === 1, { description: "first wait" });
      expect(timer.getPendingSleeps()).toEqual([4_000]);
      expect(client.callToolCalls).toHaveLength(1);
      timer.advanceTime(4_000);
      await drainUntil(
        () => client.callToolCalls.length === 2 && timer.getPendingSleepCount() === 1,
        {
          description: "second wait",
        },
      );
      timer.advanceTime(4_000);
      await expect(call).resolves.toEqual(success);
      expect(client.callToolCalls.map((c) => c.toolName)).toEqual([
        "startDevice",
        "startDevice",
        "startDevice",
      ]);
    } finally {
      await done();
    }
  });

  test("retries a device_shutting_down refusal after its retryAfterMs (#11111)", async () => {
    const { timer, client, proxy, done } = await setup({
      refusals: 1,
      retryAfterMs: 0,
      shuttingDown: true,
    });
    try {
      const call = proxy.callTool("startDevice", {});
      await drainUntil(() => timer.getPendingSleepCount() === 1, { description: "first wait" });
      expect(timer.getPendingSleeps()[0]).toBeGreaterThanOrEqual(2_000);
      timer.advanceTime(timer.getPendingSleeps()[0]);
      await expect(call).resolves.toEqual(success);
      expect(client.callToolCalls).toHaveLength(2);
    } finally {
      await done();
    }
  });

  test("gives up with the last refusal once the budget is spent", async () => {
    const { timer, client, proxy, done } = await setup({
      refusals: 99,
      retryAfterMs: 4_000,
      budgetMs: 6_000,
    });
    try {
      const call = proxy.callTool("setActiveDevice", {});
      await drainUntil(() => timer.getPendingSleepCount() === 1, { description: "first wait" });
      timer.advanceTime(4_000);
      await drainUntil(() => timer.getPendingSleepCount() === 1, { description: "clamped wait" });
      expect(timer.getPendingSleeps()).toEqual([2_000]);
      timer.advanceTime(2_000);
      await expect(call).resolves.toMatchObject({ isError: true });
      expect(client.callToolCalls).toHaveLength(3);
    } finally {
      await done();
    }
  });

  test("never waits on a non-binding tool that carries the same refusal", async () => {
    const { timer, client, proxy, done } = await setup({ refusals: 1, retryAfterMs: 4_000 });
    try {
      await expect(proxy.callTool("tapOn", {})).resolves.toMatchObject({ isError: true });
      expect(client.callToolCalls).toHaveLength(1);
      expect(timer.getSleepCallCount()).toBe(0);
    } finally {
      await done();
    }
  });
});
