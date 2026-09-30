import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  CachedHierarchy,
  HierarchyDelegateContext,
  HierarchySyncDiagnostics,
} from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

interface Harness {
  hierarchy: CtrlProxyHierarchy;
  timer: FakeTimer;
  frames: string[];
  push: (receivedAt: number) => void;
}

async function createHarness(): Promise<Harness> {
  const timer = new FakeTimer();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  await Promise.resolve();
  const frames: string[] = [];
  socket.send = (data) => {
    frames.push(String(data));
  };
  let cached: CachedHierarchy | null = null;
  const tree = {
    packageName: "com.android.settings",
    updatedAt: 123,
    screenWidth: 1080,
    screenHeight: 2400,
    hierarchy: { bounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, node: [] },
  } as CachedHierarchy["hierarchy"];
  const context: HierarchyDelegateContext = {
    getWebSocket: () => socket as never,
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
  return {
    hierarchy: new CtrlProxyHierarchy(context),
    timer,
    frames,
    push: (receivedAt) => {
      cached = { hierarchy: tree, receivedAt, fresh: true };
    },
  };
}

async function drain(): Promise<void> {
  for (let turn = 0; turn < 30; turn++) {
    await Promise.resolve();
  }
}

describe("CtrlProxyHierarchy requestHierarchySync single flight", () => {
  test("compatible callers send one frame and receive the same hierarchy", async () => {
    const h = await createHarness();
    const first = h.hierarchy.requestHierarchySync();
    const second = h.hierarchy.requestHierarchySync();
    await drain();
    expect(h.frames).toHaveLength(1);

    h.push(h.timer.now());
    h.timer.advanceTime(50);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult?.hierarchy.updatedAt).toBe(123);
    expect(secondResult).toBe(firstResult);
  });

  test("runner error reaches both callers and a later call sends a new frame", async () => {
    const h = await createHarness();
    const firstDiagnostics: HierarchySyncDiagnostics = {};
    const secondDiagnostics: HierarchySyncDiagnostics = {};
    const first = h.hierarchy.requestHierarchySync(
      undefined,
      false,
      undefined,
      10000,
      firstDiagnostics,
    );
    const second = h.hierarchy.requestHierarchySync(
      undefined,
      false,
      undefined,
      10000,
      secondDiagnostics,
    );
    await drain();
    expect(h.frames).toHaveLength(1);
    const requestId = (JSON.parse(h.frames[0]!) as { requestId: string }).requestId;
    expect(h.hierarchy.rejectPendingHierarchy(requestId, "runner failed")).toBe(true);
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(firstDiagnostics.runnerError).toBe("runner failed");
    expect(secondDiagnostics.runnerError).toBe("runner failed");

    const third = h.hierarchy.requestHierarchySync();
    await drain();
    expect(h.frames).toHaveLength(2);
    h.push(h.timer.now());
    h.timer.advanceTime(50);
    expect((await third)?.hierarchy.updatedAt).toBe(123);
  });

  test("aborting one caller leaves the shared request alive for another", async () => {
    const h = await createHarness();
    const controller = new AbortController();
    const first = h.hierarchy.requestHierarchySync(undefined, false, controller.signal);
    const second = h.hierarchy.requestHierarchySync();
    await drain();
    expect(h.frames).toHaveLength(1);

    controller.abort();
    expect(await first).toBeNull();
    h.push(h.timer.now());
    h.timer.advanceTime(50);
    expect((await second)?.hierarchy.updatedAt).toBe(123);
    expect(h.frames).toHaveLength(1);
  });

  test("a strictly newer receipt floor sends its own frame", async () => {
    const h = await createHarness();
    const first = h.hierarchy.requestHierarchySync();
    await drain();
    h.timer.advanceTime(1);
    const second = h.hierarchy.requestHierarchySync();
    await drain();
    expect(h.frames).toHaveLength(2);

    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    h.push(0);
    h.timer.advanceTime(50);
    expect((await first)?.hierarchy.updatedAt).toBe(123);
    await drain();
    expect(secondSettled).toBe(false);

    h.push(h.timer.now());
    h.timer.advanceTime(50);
    expect((await second)?.hierarchy.updatedAt).toBe(123);
  });

  test("different filtering modes send separate frames", async () => {
    const h = await createHarness();
    const first = h.hierarchy.requestHierarchySync(undefined, false);
    const second = h.hierarchy.requestHierarchySync(undefined, true);
    await drain();
    expect(h.frames).toHaveLength(2);

    h.push(h.timer.now());
    h.timer.advanceTime(50);
    expect((await first)?.hierarchy.updatedAt).toBe(123);
    expect((await second)?.hierarchy.updatedAt).toBe(123);
  });
});
