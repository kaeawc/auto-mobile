import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { WebSocketWatchRunnerClient } from "../../../src/features/watch/WatchRunnerClient";
import { WatchRunnerError } from "../../../src/features/watch/WatchRunnerError";
import { FakeWatchSocket } from "../../fakes/FakeWatchSocket";
import { FakeTimer } from "../../fakes/FakeTimer";
import hierarchy from "../../fixtures/watchos-xcuitest/sdk-hierarchy-live.json";

function arrange() {
  const timer = new FakeTimer();
  const socket = new FakeWatchSocket();
  const client = new WebSocketWatchRunnerClient("ws://127.0.0.1:8765/ws", {
    factory: () => socket,
    timer,
    timeoutMs: 50,
  });
  return { timer, socket, client };
}

describe("watch runner protocol", () => {
  test("correlates out-of-order replies and normal hierarchy payloads", async () => {
    const { client, socket, timer } = arrange();
    socket.connected();
    const first = client.hierarchy();
    const second = client.request({ type: "home" });
    await drainMicrotasks(2);
    expect(socket.sent.map((entry) => entry.type)).toEqual(["hierarchy", "home"]);
    socket.receive({ type: "home_result", requestId: socket.sent[1].requestId, success: true });
    socket.receive({
      type: "hierarchy_update",
      requestId: socket.sent[0].requestId,
      success: true,
      data: hierarchy,
    });
    expect(JSON.stringify(await first)).toBe(JSON.stringify(hierarchy));
    await second;
    expect(timer.getSleepHistory()).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    client.close();
  });
  test("refuses a non-watch runner without sending a command", async () => {
    const { client, socket } = arrange();
    socket.connected("ios");
    await expect(client.request({ type: "home" })).rejects.toThrow("platform must be watchos");
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
  });
  test.each(["unsupported_on_watchos", "invalid_request", "command_failed"])(
    "preserves %s on an actionable command error",
    async (errorCode) => {
      const { client, socket } = arrange();
      socket.connected();
      const pending = client.request({ type: "tap", identifier: "missing" });
      await drainMicrotasks(2);
      const failure = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      socket.receive({
        type: "error",
        requestId: socket.sent[0].requestId,
        success: false,
        error: "Unsupported command",
        errorCode,
      });
      const error = await failure;
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toBeInstanceOf(WatchRunnerError);
      expect((error as WatchRunnerError).errorCode).toBe(errorCode);
      client.close();
    },
  );
  test("times out without real sleeps and ignores a late reply", async () => {
    const { client, socket, timer } = arrange();
    socket.connected();
    const pending = client.request({ type: "home" });
    const rejection = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainMicrotasks(2);
    timer.advanceTime(50);
    expect(String(await rejection)).toContain("timed out");
    socket.receive({ type: "home_result", requestId: socket.sent[0].requestId, success: true });
    expect(timer.getSleepHistory()).toEqual([]);
    client.close();
  });
  test("a late handshake cannot send a timed-out command", async () => {
    const { client, socket, timer } = arrange();
    const pending = client.request({ type: "home" });
    const rejection = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    timer.advanceTime(50);
    expect(String(await rejection)).toContain("timed out");
    socket.connected();
    await drainMicrotasks(2);
    expect(socket.sent).toEqual([]);
    client.close();
  });
  test("aborts waiting commands before dispatch and rejects pending commands on disconnect", async () => {
    const { client, socket } = arrange();
    const abort = new AbortController();
    abort.abort(new ActionableError("cancelled"));
    await expect(client.request({ type: "home" }, abort.signal)).rejects.toThrow("cancelled");
    socket.connected();
    await drainMicrotasks(2);
    expect(socket.sent).toEqual([]);
    const pending = client.request({ type: "home" });
    await drainMicrotasks(2);
    socket.disconnect();
    await expect(pending).rejects.toThrow("disconnected");
  });
  test("does not accept the wrong response type or unknown request id", async () => {
    const { client, socket, timer } = arrange();
    socket.connected();
    const pending = client.request({ type: "home" });
    const rejection = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainMicrotasks(2);
    socket.receive({ type: "tap_result", requestId: socket.sent[0].requestId, success: true });
    socket.receive({ type: "home_result", requestId: "unknown", success: true });
    timer.advanceTime(50);
    expect(String(await rejection)).toContain("timed out");
    client.close();
  });
  test("rejects commands not advertised and validates hierarchy data", async () => {
    const { client, socket } = arrange();
    socket.receive({ type: "connected", platform: "watchos", supportedCommands: ["hierarchy"] });
    await expect(client.request({ type: "home" })).rejects.toThrow("does not support home");
    expect(socket.sent).toEqual([]);
    const pending = client.hierarchy();
    await drainMicrotasks(2);
    socket.receive({
      type: "hierarchy_update",
      requestId: socket.sent[0].requestId,
      success: true,
      data: {},
    });
    await expect(pending).rejects.toThrow("Invalid watch hierarchy");
    client.close();
  });
});
