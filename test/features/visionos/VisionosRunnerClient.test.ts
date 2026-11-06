import { expect, test } from "bun:test";
import { WebSocketVisionosRunnerClient } from "../../../src/features/visionos/VisionosRunnerClient";
import { normalizeVisionosHierarchy } from "../../../src/features/visionos/VisionosHierarchy";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { FakeWatchSocket } from "../../fakes/FakeWatchSocket";
import { FakeTimer } from "../../fakes/FakeTimer";
import { visionosProbeHierarchy } from "../../fakes/FakeVisionosRunnerClient";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import probe from "../../fixtures/visionos-xcuitest/probe-capture.json";

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
