import { expect, test } from "bun:test";
import {
  VISIONOS_HIERARCHY_TIMEOUT_MS,
  VISIONOS_REQUEST_TIMEOUT_MS,
  WebSocketVisionosRunnerClient,
} from "../../../src/features/visionos/VisionosRunnerClient";
import { normalizeVisionosHierarchy } from "../../../src/features/visionos/VisionosHierarchy";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { FakeWatchSocket } from "../../fakes/FakeWatchSocket";
import { FakeTimer } from "../../fakes/FakeTimer";
import { visionosProbeHierarchy } from "../../fakes/FakeVisionosRunnerClient";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import probe from "../../fixtures/visionos-xcuitest/probe-capture.json";
import safariHierarchyApiDisabled from "../../fixtures/visionos-xcuitest/safari-hierarchy-api-disabled.json";

const connected = {
  type: "connected",
  platform: "visionos",
  supportedCommands: ["request_hierarchy", "request_tap_element", "request_append_text"],
};
function fixture() {
  const socket = new FakeWatchSocket();
  const timer = new FakeTimer();
  const client = new WebSocketVisionosRunnerClient("ws://fake/ws", {
    factory: () => socket,
    timer,
  });
  return { socket, timer, client };
}

test.each([{ snapshots: probe.snapshotBefore }, { snapshots: probe.snapshotAfterImmersive }])(
  "normalizes the captured focus and ornament identity",
  async ({ snapshots }) => {
    const { socket, timer, client } = fixture();
    socket.receive(connected);
    const pending = client.hierarchy();
    await drainMicrotasks(2);
    socket.receive({
      type: "hierarchy_update",
      requestId: socket.sent[0].requestId,
      data: visionosProbeHierarchy(snapshots),
    });
    const tree = normalizeVisionosHierarchy(await pending);
    const elements = new DefaultElementParser()
      .flattenViewHierarchy(tree)
      .map(({ element }) => element);
    expect(elements.find((node) => node["resource-id"] === "field")?.focused === "true").toBe(
      snapshots.find((node) => node.id === "field")!.hasFocus,
    );
    expect(elements.find((node) => node["resource-id"] === "orn")?.bounds).toEqual({
      left: 16,
      top: 16,
      right: 83,
      bottom: 60,
    });
    expect(timer.getSleepHistory()).toEqual([]);
    client.close();
  },
);

test.each(["ios", "watchos", "tvos", "android"])("rejects a %s handshake", async (platform) => {
  const { socket, client } = fixture();
  socket.receive({ ...connected, platform });
  await expect(client.hierarchy()).rejects.toThrow("platform must be visionos");
  expect(socket.closed).toBe(true);
  expect(socket.sent).toEqual([]);
});

test("correlates taps and typing and propagates runner refusal", async () => {
  const { socket, client } = fixture();
  socket.receive(connected);
  const pending = client.request({ type: "request_tap_element", identifier: "orn" });
  await drainMicrotasks(2);
  socket.receive({ type: "tap_element_result", requestId: "other", success: true });
  socket.receive({
    type: "tap_element_result",
    requestId: socket.sent[0].requestId,
    success: true,
  });
  await pending;
  const typing = client.request({ type: "request_append_text", text: "hello" });
  await drainMicrotasks(2);
  socket.receive({
    type: "error",
    requestId: socket.sent[1].requestId,
    error: "no focused text input",
    errorCode: "invalid_parameter",
  });
  await expect(typing).rejects.toThrow("no focused text input");
  client.close();
});

test("maps Safari's captured AX window failure to per-app screenshot advice", async () => {
  const { socket, client } = fixture();
  socket.receive(connected);
  const pending = client.hierarchy();
  await drainMicrotasks(2);
  socket.receive({
    ...safariHierarchyApiDisabled,
    requestId: socket.sent[0].requestId,
  });
  const failure = await pending.then(
    () => undefined,
    (error: unknown) => error as { cause?: unknown; errorCode?: string; message?: string },
  );
  expect(failure?.errorCode).toBe("accessibility_api_disabled");
  expect(failure?.message).toContain("accessibility");
  expect(failure?.message).toContain("this app's accessibility window");
  expect(failure?.message).toContain("after relaunching");
  expect(failure?.message).toContain("Other apps on the simulator may still work");
  expect(failure?.message).toContain("screenshot");
  expect(failure?.message).toContain("simctl");
  expect(failure?.message).not.toContain("Re-create");
  expect(failure?.message).not.toContain("disabled");
  expect(failure?.cause).toBe(safariHierarchyApiDisabled.error);
  expect(failure?.message).not.toContain("not relaunched");
  client.close();
});

test.each([
  { type: "request_tap_element" as const, identifier: "orn" },
  { type: "request_append_text" as const, text: "hello" },
])("maps $type's AX window failure without claiming a relaunch", async (command) => {
  const { socket, timer, client } = fixture();
  socket.receive(connected);
  const pending = client.request(command);
  await drainMicrotasks(2);
  socket.receive({
    ...safariHierarchyApiDisabled,
    requestId: socket.sent[0].requestId,
  });
  const failure = await pending.then(
    () => undefined,
    (error: unknown) => error as { cause?: unknown; errorCode?: string; message?: string },
  );
  expect(failure?.errorCode).toBe("accessibility_api_disabled");
  expect(failure?.message).toContain("this app's accessibility window");
  expect(failure?.message).toContain(`so ${command.type} failed`);
  expect(failure?.message).toContain("the app was not relaunched");
  expect(failure?.message).not.toContain("after relaunching");
  expect(failure?.message).toContain("Observe the app first");
  expect(failure?.message).toContain("retry this step");
  expect(failure?.message).toContain("Other apps on the simulator may still work");
  expect(failure?.message).toContain("simctl");
  expect(failure?.cause).toBe(safariHierarchyApiDisabled.error);
  expect(timer.getSleepHistory()).toEqual([]);
  client.close();
});

test("ordinary hierarchy errors keep command_failed and their original message", async () => {
  const { socket, client } = fixture();
  socket.receive(connected);
  const pending = client.hierarchy();
  await drainMicrotasks(2);
  socket.receive({
    ...safariHierarchyApiDisabled,
    requestId: socket.sent[0].requestId,
    error: "Error getting main window kAXErrorCannotComplete",
  });
  const failure = await pending.then(
    () => undefined,
    (error: unknown) => error as { errorCode?: string; message?: string },
  );
  expect(failure?.errorCode).toBe("command_failed");
  expect(failure?.message).toBe("Error getting main window kAXErrorCannotComplete");
  client.close();
});

test("preserves ordinary runner errors and resolves successful responses", async () => {
  const { socket, client } = fixture();
  socket.receive(connected);
  const failed = client.request({ type: "request_tap_element", identifier: "orn" });
  await drainMicrotasks(2);
  socket.receive({
    type: "error",
    requestId: socket.sent[0].requestId,
    error: "element not found",
  });
  const failure = await failed.then(
    () => undefined,
    (error: unknown) => error as { errorCode?: string; message?: string },
  );
  expect(failure?.errorCode).toBe("command_failed");
  expect(failure?.message).toBe("element not found");

  const succeeded = client.request({ type: "request_tap_element", identifier: "orn" });
  await drainMicrotasks(2);
  socket.receive({
    type: "tap_element_result",
    requestId: socket.sent[1].requestId,
    success: true,
  });
  expect(await succeeded).toBeUndefined();
  client.close();
});

test("a sent input that times out is reported as an unknown outcome, a hierarchy is not", async () => {
  const { socket, timer, client } = fixture();
  socket.receive(connected);
  const typing = client
    .request({ type: "request_append_text", text: "hello" }, undefined, { timeoutMs: 50 })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await drainMicrotasks(2);
  expect(socket.sent).toHaveLength(1);
  timer.advanceTime(50);
  const failure = (await typing) as { errorCode?: string; message?: string };
  expect(failure.errorCode).toBe("input_outcome_unknown");
  expect(failure.message).toContain("may still be applied");
  const hierarchy = client.hierarchy(undefined, { timeoutMs: 20 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await drainMicrotasks(2);
  timer.advanceTime(20);
  expect(((await hierarchy) as { errorCode?: string }).errorCode).toBeUndefined();
  client.close();
});

test("missing handshake times out with FakeTimer and no late input", async () => {
  const { socket, timer, client } = fixture();
  const failed = client
    .request({ type: "request_append_text", text: "hello" }, undefined, { timeoutMs: 50 })
    .then(
      () => "ok",
      (error: unknown) => String(error),
    );
  timer.advanceTime(50);
  expect(await failed).toContain("timed out");
  socket.receive(connected);
  await drainMicrotasks(2);
  expect(socket.sent).toEqual([]);
  expect(timer.getSleepHistory()).toEqual([]);
  client.close();
});

test("unadvertised command and malformed hierarchy fail closed", async () => {
  const { socket, client } = fixture();
  socket.receive({ ...connected, supportedCommands: ["request_hierarchy"] });
  await expect(client.request({ type: "request_tap_element", identifier: "orn" })).rejects.toThrow(
    "does not support",
  );
  const pending = client.hierarchy();
  await drainMicrotasks(2);
  socket.receive({ type: "hierarchy_update", requestId: socket.sent[0].requestId, data: {} });
  await expect(pending).rejects.toThrow("Invalid visionos hierarchy");
  client.close();
});

test("the connected handshake alone makes the runner ready, with no hierarchy request", async () => {
  const { socket, timer, client } = fixture();
  const ready = client.waitUntilConnected();
  socket.receive(connected);
  await ready;
  expect(socket.sent).toEqual([]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  client.close();
});

test("a missing handshake fails readiness within the 5 s default budget", async () => {
  const { timer, client } = fixture();
  const ready = client.waitUntilConnected().then(
    () => "ready",
    (error: unknown) => String(error),
  );
  await drainMicrotasks(2);
  timer.advanceTime(4999);
  await drainMicrotasks(2);
  timer.advanceTime(1);
  expect(await ready).toContain("timed out");
  client.close();
});

test("a refused connection fails readiness immediately so startup can retry", async () => {
  const { socket, client } = fixture();
  const ready = client.waitUntilConnected();
  socket.disconnect();
  await expect(ready).rejects.toThrow("disconnected");
  expect(client.isUsable()).toBe(false);
});

test("a system-app hierarchy answered after 8.2 s fits the default hierarchy budget (#17199)", async () => {
  const { socket, timer, client } = fixture();
  socket.receive(connected);
  const pending = client.hierarchy();
  await drainMicrotasks(2);
  timer.advanceTime(8200);
  socket.receive({
    type: "hierarchy_update",
    requestId: socket.sent[0].requestId,
    data: visionosProbeHierarchy(),
  });
  expect((await pending).packageName).toBe(visionosProbeHierarchy().packageName);
  client.close();
});

test("hierarchy defaults to the 20 s budget while inputs keep 5 s", async () => {
  const { socket, timer, client } = fixture();
  socket.receive(connected);
  const hierarchy = client.hierarchy().then(
    () => "ok",
    (error: unknown) => String(error),
  );
  const typing = client.request({ type: "request_append_text", text: "hello" }).then(
    () => "ok",
    (error: unknown) => (error as { errorCode?: string }).errorCode,
  );
  await drainMicrotasks(2);
  expect(timer.getPendingTimeouts().sort((a, b) => a - b)).toEqual([
    VISIONOS_REQUEST_TIMEOUT_MS,
    VISIONOS_HIERARCHY_TIMEOUT_MS,
  ]);
  timer.advanceTime(VISIONOS_REQUEST_TIMEOUT_MS);
  expect(await typing).toBe("input_outcome_unknown");
  timer.advanceTime(VISIONOS_HIERARCHY_TIMEOUT_MS - VISIONOS_REQUEST_TIMEOUT_MS);
  expect(await hierarchy).toContain("timed out");
  client.close();
});
