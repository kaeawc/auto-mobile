import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import { AndroidHierarchyWaiter } from "../../../../src/features/observe/android/AndroidHierarchyWaiter";
import type {
  CachedHierarchy,
  HierarchyDelegateContext,
  HierarchySyncDiagnostics,
} from "../../../../src/features/observe/android/types";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

async function createHarness(isolated: boolean) {
  const timer = new FakeTimer();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  await Promise.resolve();
  let cached: CachedHierarchy | null = null;
  const frames: { requestId: string }[] = [];
  socket.send = (data) => {
    frames.push(JSON.parse(String(data)) as { requestId: string });
  };
  const context: HierarchyDelegateContext = {
    getWebSocket: () => socket,
    requestManager: new RequestManager(timer),
    timer,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device: { deviceId: "fake", platform: "android", name: "Fake" },
    adb: new FakeAdbExecutor(),
    getCachedHierarchy: () => cached,
    setCachedHierarchy: (value) => {
      cached = value;
    },
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };
  const hierarchy = new CtrlProxyHierarchy(context);
  const wait = spyOn(AndroidHierarchyWaiter.prototype, "waitForFreshData");
  const read = (timeoutMs?: number, signal?: AbortSignal, diagnostics?: HierarchySyncDiagnostics) =>
    isolated
      ? hierarchy.requestHierarchySyncWithOptions({
          perf: new NoOpPerformanceTracker(),
          disableAllFiltering: false,
          observerMode: false,
          timeoutMs: timeoutMs ?? 10000,
          signal,
          diagnostics,
          onRequestId: () => {},
        })
      : hierarchy.requestHierarchySync(undefined, false, signal, { timeoutMs, diagnostics });
  return {
    hierarchy,
    timer,
    frames,
    wait,
    read,
    reply: () => {
      cached = {
        receivedAt: timer.now(),
        fresh: true,
        hierarchy: {
          packageName: "com.android.settings",
          updatedAt: 123,
          screenWidth: 1080,
          screenHeight: 2400,
          hierarchy: { node: [] },
        },
      };
    },
  };
}

async function drain(): Promise<void> {
  for (let turn = 0; turn < 30; turn++) {
    await Promise.resolve();
  }
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function timeoutRead(h: Harness, budget: number, requestedBudget?: number): Promise<void> {
  const pending = h.read(requestedBudget);
  await drain();
  expect(h.wait.mock.calls.at(-1)?.[0]).toBe(budget);
  h.timer.advanceTime(budget);
  expect(await pending).toBeNull();
}

afterEach(() => {
  // Restore only the harness's pass-through spies; all timers are fake and per test.
  for (const h of harnesses) {
    h.wait.mockRestore();
  }
  harnesses.length = 0;
});
const harnesses: Harness[] = [];
async function harness(isolated: boolean): Promise<Harness> {
  const h = await createHarness(isolated);
  harnesses.push(h);
  return h;
}

describe.each([false, true])("CtrlProxyHierarchy sync cooldown (isolated=%s)", (isolated) => {
  test("a full-budget timeout makes later default reads probe for only 2000ms", async () => {
    const h = await harness(isolated);
    await timeoutRead(h, 10000);
    await timeoutRead(h, 2000);
    // A short failed probe does not re-arm the original 60-second cooldown.
    h.timer.advanceTime(58000);
    await timeoutRead(h, 10000);
  });

  test("success clears the cooldown and restores the full budget", async () => {
    const h = await harness(isolated);
    await timeoutRead(h, 10000);
    const pending = h.read();
    await drain();
    expect(h.wait.mock.calls.at(-1)?.[0]).toBe(2000);
    h.reply();
    h.timer.advanceTime(50);
    expect((await pending)?.hierarchy.updatedAt).toBe(123);
    // Clear the reply so the next read really has to wait again.
    h.hierarchy.invalidateCache();
    await timeoutRead(h, 10000);
  });

  test("expiry restores the full budget even without a successful read", async () => {
    const h = await harness(isolated);
    await timeoutRead(h, 10000);
    h.timer.advanceTime(60000);
    await timeoutRead(h, 10000);
  });

  test.each([500, 2950])("a %sms timeout does not arm the cooldown", async (budget) => {
    const h = await harness(isolated);
    await timeoutRead(h, budget, budget);
    await timeoutRead(h, 10000);
  });

  test("a timeout at the 3000ms threshold arms the cooldown", async () => {
    const h = await harness(isolated);
    await timeoutRead(h, 3000, 3000);
    await timeoutRead(h, 2000);
  });

  test("a smaller caller budget is preserved during cooldown", async () => {
    const h = await harness(isolated);
    await timeoutRead(h, 10000);
    await timeoutRead(h, 500, 500);
  });

  test("an aborted caller does not arm the cooldown after a long wait", async () => {
    const h = await harness(isolated);
    const controller = new AbortController();
    const pending = h.read(undefined, controller.signal);
    await drain();
    h.timer.advanceTime(4000);
    controller.abort();
    expect(await pending).toBeNull();
    await timeoutRead(h, 10000);
  });

  test.each([false, true])(
    "runner errors do not arm it (caller diagnostics=%s)",
    async (details) => {
      const h = await harness(isolated);
      const diagnostics: HierarchySyncDiagnostics | undefined = details ? {} : undefined;
      const pending = h.read(undefined, undefined, diagnostics);
      await drain();
      h.timer.advanceTime(4000);
      expect(h.hierarchy.rejectPendingHierarchy(h.frames[0]!.requestId, "runner failed")).toBe(
        true,
      );
      expect(await pending).toBeNull();
      if (diagnostics) {
        expect(diagnostics.runnerError).toBe("runner failed");
      }
      await timeoutRead(h, 10000);
    },
  );
});

test("compatible callers still join a flight with the clamped budget", async () => {
  const h = await harness(false);
  await timeoutRead(h, 10000);
  h.frames.length = 0;
  const first = h.read();
  const second = h.read();
  await drain();
  expect(h.frames).toHaveLength(1);
  expect(h.wait.mock.calls.at(-1)?.[0]).toBe(2000);
  h.timer.advanceTime(2000);
  expect(await Promise.all([first, second])).toEqual([null, null]);
});

test("hierarchy clients keep their cooldowns separate even for the same device", async () => {
  const first = await harness(false);
  const second = await harness(false);
  await timeoutRead(first, 10000);
  second.timer.advanceTime(first.timer.now());
  await timeoutRead(second, 10000);
});
