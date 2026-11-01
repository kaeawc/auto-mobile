import { expect, test } from "bun:test";
import { WebSocketTvosRunnerClient } from "../../../src/features/tvos/TvosRunnerClient";
import { normalizeTvosHierarchy } from "../../../src/features/tvos/TvosHierarchy";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { FakeWatchSocket } from "../../fakes/FakeWatchSocket";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import connected from "../../fixtures/tvos-xcuitest/tvos-runner-connected.json";
import b01 from "../../fixtures/tvos-xcuitest/tvos-runner-hierarchy-focus-b01.json";
import field from "../../fixtures/tvos-xcuitest/tvos-runner-hierarchy-focus-field.json";
import pressResult from "../../fixtures/tvos-xcuitest/tvos-runner-press-result.json";

function fixture() {
  const socket = new FakeWatchSocket();
  const timer = new FakeTimer();
  const client = new WebSocketTvosRunnerClient("ws://fake/ws", { factory: () => socket, timer });
  return { socket, timer, client };
}

test.each([
  [b01, "B01", "am-text-field"],
  [field, "am-text-field", "B01"],
] as const)(
  "preserves focus through the runner hierarchy and iOS converter",
  async (capture, focused, other) => {
    const { socket, timer, client } = fixture();
    socket.receive(connected);
    const pending = client.hierarchy();
    await drainMicrotasks(2);
    expect(socket.sent[0].type).toBe("request_hierarchy");
    socket.receive({ ...capture, requestId: socket.sent[0].requestId });
    const result = normalizeTvosHierarchy(await pending);
    const elements = new DefaultElementParser().flattenViewHierarchy(result).map((e) => e.element);
    expect(elements.find((e) => e["resource-id"] === focused)?.focused).toBe("true");
    const unfocused = elements.find((e) => e["resource-id"] === other);
    expect(unfocused).toBeDefined();
    expect(unfocused?.focused).not.toBe("true");
    expect(unfocused?.focused).not.toBe(true);
    expect(timer.getSleepHistory()).toEqual([]);
    client.close();
  },
);

test.each(["ios", "watchos", "android"])("refuses a %s handshake", async (platform) => {
  const { socket, client } = fixture();
  socket.receive({ ...connected, platform });
  await expect(client.hierarchy()).rejects.toThrow("platform must be tvos");
  expect(socket.sent).toEqual([]);
  expect(socket.closed).toBe(true);
});

test("correlates a real remote press result and reports runner errors", async () => {
  const { socket, client } = fixture();
  socket.receive(connected);
  const pending = client.request({ type: "request_press_button", action: "right" });
  await drainMicrotasks(2);
  expect(socket.sent[0]).toMatchObject({ type: "request_press_button", action: "right" });
  socket.receive({ ...pressResult, requestId: socket.sent[0].requestId });
  await pending;
  const failed = client.request({ type: "request_press_button", action: "menu" });
  await drainMicrotasks(2);
  socket.receive({
    type: "error",
    requestId: socket.sent[1].requestId,
    success: false,
    error: "remote unavailable",
  });
  await expect(failed).rejects.toThrow("remote unavailable");
  client.close();
});

test("accepts the runner screenshot envelope without a success field", async () => {
  const { socket, client, timer } = fixture();
  socket.receive(connected);
  const pending = client.request({ type: "request_screenshot" });
  await drainMicrotasks(2);
  socket.receive({
    type: "screenshot",
    requestId: socket.sent[0].requestId,
    data: "cG5n",
    format: "png",
  });
  expect(await pending).toBe("cG5n");
  expect(timer.getSleepHistory()).toEqual([]);
  client.close();
});

test("bounds a missing handshake and never dispatches after its deadline", async () => {
  const { socket, client, timer } = fixture();
  const failed = client
    .request({ type: "request_press_button", action: "home" }, undefined, { timeoutMs: 50 })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  timer.advanceTime(50);
  expect(String(await failed)).toContain("timed out");
  socket.receive(connected);
  await drainMicrotasks(2);
  expect(socket.sent).toEqual([]);
  expect(timer.getSleepHistory()).toEqual([]);
  client.close();
});
