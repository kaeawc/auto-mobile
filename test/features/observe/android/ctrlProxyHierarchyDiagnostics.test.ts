import { expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  HierarchyDelegateContext,
  HierarchySyncDiagnostics,
} from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

async function harness() {
  const timer = new FakeTimer();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  await Promise.resolve();
  const frames: string[] = [];
  socket.send = (data) => {
    frames.push(String(data));
  };
  const adb = new FakeAdbExecutor();
  const context: HierarchyDelegateContext = {
    getWebSocket: () => socket,
    timer,
    requestManager: new RequestManager(timer),
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device: { deviceId: "fake", platform: "android", name: "Fake" },
    adb,
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };
  const hierarchy = new CtrlProxyHierarchy(context);
  const diagnostics: HierarchySyncDiagnostics = {};
  const request = (signal?: AbortSignal, details = diagnostics) =>
    hierarchy.requestHierarchySync(undefined, false, signal, 250, details, 2);
  return { timer, socket, frames, adb, context, hierarchy, diagnostics, request };
}

async function drain() {
  for (let turn = 0; turn < 30; turn++) {
    await Promise.resolve();
  }
}

test("selected-display sync reports connection refusal without a dispatch", async () => {
  const h = await harness();
  h.context.ensureConnected = async () => false;
  expect(await h.request()).toBeNull();
  expect(h.diagnostics).toMatchObject({
    failureReason: "Failed to establish CtrlProxy WebSocket connection",
  });
  expect(h.frames).toEqual([]);
});

test("selected-display sync preserves a thrown connection error", async () => {
  const h = await harness();
  h.context.ensureConnected = async () => {
    throw new Error("handshake refused");
  };
  expect(await h.request()).toBeNull();
  expect(h.diagnostics).toMatchObject({ failureReason: "handshake refused" });
});

test("selected-display sync preserves a send error without broadcasting", async () => {
  const h = await harness();
  h.socket.send = () => {
    throw new Error("socket write failed");
  };
  expect(await h.request()).toBeNull();
  expect(h.diagnostics).toMatchObject({
    failureReason: "Unable to request hierarchy for Android display 2: socket write failed",
  });
  expect(h.adb.getExecutedCommands()).toEqual([]);
});

test("selected-display sync distinguishes response timeout from reachability", async () => {
  const h = await harness();
  const pending = h.request();
  await drain();
  expect(h.frames).toHaveLength(1);
  h.timer.advanceTime(250);
  expect(await pending).toBeNull();
  expect(h.diagnostics).toMatchObject({
    failureReason: "Timed out waiting for hierarchy response after 250ms",
  });
  expect(h.timer.getPendingIntervalCount()).toBe(0);
});

test("selected-display sync distinguishes socket disconnect from timeout", async () => {
  const h = await harness();
  const pending = h.request();
  await drain();
  h.hierarchy.rejectAllPendingHierarchy("service closed");
  expect(await pending).toBeNull();
  expect(h.diagnostics).toMatchObject({
    failureReason: "CtrlProxy WebSocket disconnected while waiting for hierarchy response",
  });
  expect(h.timer.now()).toBe(0);
});

test("selected-display joined sync carries runner error to each caller", async () => {
  const h = await harness();
  const otherDiagnostics: HierarchySyncDiagnostics = {};
  const first = h.request();
  const second = h.request(undefined, otherDiagnostics);
  await drain();
  expect(h.frames).toHaveLength(1);
  const { requestId } = JSON.parse(h.frames[0]!) as { requestId: string };
  expect(h.hierarchy.rejectPendingHierarchy(requestId, "panel unavailable")).toBe(true);
  expect(await Promise.all([first, second])).toEqual([null, null]);
  for (const details of [h.diagnostics, otherDiagnostics]) {
    expect(details).toMatchObject({
      runnerError: "panel unavailable",
      failureReason: "runner error: panel unavailable",
    });
  }
});

test("selected-display caller abort does not misattribute the joined flight failure", async () => {
  const h = await harness();
  const controller = new AbortController();
  const otherDiagnostics: HierarchySyncDiagnostics = {};
  const first = h.request(controller.signal);
  const second = h.request(undefined, otherDiagnostics);
  await drain();
  controller.abort(new Error("owner call cancelled"));
  expect(await first).toBeNull();
  expect(h.diagnostics).toMatchObject({ failureReason: "owner call cancelled" });
  expect(otherDiagnostics).toEqual({});
  h.timer.advanceTime(250);
  expect(await second).toBeNull();
  expect(otherDiagnostics).toMatchObject({
    failureReason: "Timed out waiting for hierarchy response after 250ms",
  });
  expect(h.diagnostics).toMatchObject({ failureReason: "owner call cancelled" });
});
