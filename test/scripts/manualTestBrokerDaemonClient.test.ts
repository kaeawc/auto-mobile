import { expect, test } from "bun:test";
import {
  BrokerTransportError,
  createFrameBrokerDaemonClient,
  waitForBrokerRelease,
} from "../../scripts/manual-test/brokerDaemonClient";
import type { FrameConnection } from "../../scripts/manual-test/frameWire";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { FakeBrokerDaemonClient } from "../helpers/FakeBrokerDaemonClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const released: SessionBrokerResult = {
  contractVersion: 1,
  requestId: "request",
  outcome: "released",
  sessionUuid: "session",
  profile: null,
  cleanupPending: false,
};
class Duplex implements FrameConnection {
  frames: Array<{ id: string; method: string; params: unknown; timeoutMs: number }> = [];
  destroyed = false;
  data: (chunk: Buffer) => void = () => {};
  close: (error?: Error) => void = () => {};
  reply: { success: boolean; result?: unknown; code?: string; error?: string } | undefined = {
    success: true,
    result: released,
  };
  write(text: string): void {
    const frame = JSON.parse(text);
    this.frames.push(frame);
    if (this.reply) {
      const response = JSON.stringify({ id: frame.id, ...this.reply });
      // Exercise incremental framing and unrelated IDs.
      this.data(Buffer.from('{"id":"other","success":true}\n' + response.slice(0, 8)));
      this.data(Buffer.from(response.slice(8) + "\n"));
    }
  }
  onData(listener: (chunk: Buffer) => void): void {
    this.data = listener;
  }
  onClose(listener: (error?: Error) => void): void {
    this.close = listener;
  }
  end(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}
function fixture() {
  const timer = new FakeTimer();
  const sockets: Duplex[] = [];
  const replies: Duplex["reply"][] = [];
  const client = createFrameBrokerDaemonClient({
    socketPath: "/batch/broker.sock",
    timer,
    ids: new FakeIdGenerator(),
    connect: async (path) => {
      expect(path).toBe("/batch/broker.sock");
      const socket = new Duplex();
      if (replies.length) {
        socket.reply = replies.shift();
      }
      sockets.push(socket);
      return socket;
    },
  });
  return { timer, sockets, replies, client };
}
test("frame client uses exact daemon methods, fresh connections, tokens and budgets", async () => {
  const f = fixture();
  f.replies.push(
    { success: true, result: { capabilities: ["session-broker/v1"] } },
    { success: true, result: released },
    { success: true, result: released },
    { success: true, result: { sessionUuid: "session", outcome: "released" } },
    {
      success: true,
      result: { sessionId: "session", assignedDevice: "native", platform: "android" },
    },
    {
      success: true,
      result: {
        structuredContent: {
          devices: [
            { name: "ambroker-device", platform: "android", runtime: { deviceId: "native" } },
          ],
        },
      },
    },
    {
      success: true,
      result: { sessionId: "session", assignedDevice: "native", platform: "android" },
    },
  );
  expect(await f.client.capabilities()).toEqual(["session-broker/v1"]);
  expect(await f.client.status("request", "secret")).toEqual(released);
  expect(await f.client.abandon("request", "secret")).toEqual(released);
  expect(await f.client.release("session", "secret")).toEqual({
    sessionUuid: "session",
    outcome: "released",
  });
  expect(await f.client.info("session")).toEqual({
    sessionId: "session",
    assignedDevice: "native",
    platform: "android",
    nativeDevice: { name: "ambroker-device", deviceId: "native", platform: "android" },
  });
  expect(f.sockets.map((s) => s.frames[0])).toMatchObject([
    { method: "daemon/capabilities", params: {}, timeoutMs: 5000 },
    {
      method: "daemon/sessionRequestStatus",
      params: { requestId: "request", livenessOwnerToken: "secret" },
      timeoutMs: 5000,
    },
    {
      method: "daemon/abandonSessionRequest",
      params: { requestId: "request", livenessOwnerToken: "secret" },
      timeoutMs: 240000,
    },
    {
      method: "daemon/releaseBrokerSession",
      params: { sessionId: "session", livenessOwnerToken: "secret" },
      timeoutMs: 240000,
    },
    { method: "daemon/sessionInfo", params: { sessionId: "session" }, timeoutMs: 5000 },
    { method: "tools/call", params: { name: "listDevices", arguments: {} }, timeoutMs: 5000 },
    { method: "daemon/sessionInfo", params: { sessionId: "session" }, timeoutMs: 5000 },
  ]);
  expect(f.sockets.every((s) => s.destroyed)).toBe(true);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});
test("unknown requests map to absence; unauthorized requests and malformed envelopes reject", async () => {
  const f = fixture();
  f.replies.push(
    { success: false, code: "session_request_not_found" },
    { success: false, error: "another liveness owner" },
    { success: true, result: {} },
  );
  expect(await f.client.status("request", "secret")).toBeUndefined();
  await expect(f.client.status("request", "secret")).rejects.toThrow("another liveness owner");
  await expect(f.client.abandon("request", "secret")).rejects.toThrow("Invalid broker result");
  expect(f.sockets.every((s) => s.destroyed)).toBe(true);
});
test("silent sockets expire at short and cleanup deadlines with FakeTimer", async () => {
  for (const [op, budget] of [
    ["status", 5000],
    ["release", 240000],
    ["abandon", 240000],
  ] as const) {
    const f = fixture();
    f.replies.push(undefined);
    const pending = f.client[op]("request", "secret");
    const assertion = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainUntilQuiescent(f.timer);
    f.timer.advanceTime(budget);
    expect(await assertion).toBeInstanceOf(Error);
    expect(await assertion).not.toBeInstanceOf(BrokerTransportError);
    expect(f.sockets[0].destroyed).toBe(true);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  }
});
test("late connect is destroyed without writing after deadline", async () => {
  const timer = new FakeTimer();
  let complete: (socket: FrameConnection) => void = () => {};
  const client = createFrameBrokerDaemonClient({
    socketPath: "/fake",
    timer,
    connect: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const pending = client.capabilities();
  const assertion = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  timer.advanceTime(5000);
  expect(await assertion).toBeInstanceOf(Error);
  const socket = new Duplex();
  complete(socket);
  await drainUntilQuiescent(timer);
  expect(socket.destroyed).toBe(true);
  expect(socket.frames).toEqual([]);
});
test("closed and oversized sockets fail and clean up", async () => {
  for (const mode of ["closed", "oversized", "invalid"] as const) {
    const f = fixture();
    f.replies.push(undefined);
    const pending = f.client.capabilities();
    const assertion = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainUntilQuiescent(f.timer);
    if (mode === "closed") {
      f.sockets[0].close();
    } else {
      f.sockets[0].data(
        Buffer.from(mode === "invalid" ? "not-json\n" : "x".repeat(1024 * 1024 + 1)),
      );
    }
    expect(await assertion).toBeInstanceOf(Error);
    if (mode === "closed") {
      expect(await assertion).toBeInstanceOf(BrokerTransportError);
    } else {
      expect(await assertion).not.toBeInstanceOf(BrokerTransportError);
    }
    expect(f.sockets[0].destroyed).toBe(true);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  }
});
test("release polling joins pending cleanup and cannot exceed the overall deadline", async () => {
  const timer = new FakeTimer();
  const client = new FakeBrokerDaemonClient();
  client.statusResults = [{ ...released, cleanupPending: true }, released];
  const pending = waitForBrokerRelease({
    client,
    requestId: "request",
    token: "secret",
    timer,
    requireReleased: true,
  });
  await drainUntilQuiescent(timer);
  timer.advanceTime(250);
  expect(await pending).toEqual(released);
  client.statusResults = [undefined];
  const expired = waitForBrokerRelease({ client, requestId: "request", token: "secret", timer });
  const assertion = expired.then(
    () => undefined,
    (error: unknown) => error,
  );
  await drainUntilQuiescent(timer);
  timer.advanceTime(240000);
  expect(await assertion).toBeInstanceOf(Error);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  timer.reset();
});

test.each(["missing", "ambiguous", "refused", "rebound", "ended"])(
  "native info refuses %s inventory/binding evidence",
  async (mode) => {
    const f = fixture();
    const info = { sessionId: "session", assignedDevice: "native", platform: "android" };
    const device = {
      name: "ambroker-device",
      platform: "android",
      runtime: { deviceId: "native" },
    };
    f.replies.push(
      { success: true, result: info },
      {
        success: true,
        result:
          mode === "refused"
            ? { isError: true }
            : {
                structuredContent: {
                  devices:
                    mode === "missing" ? [] : mode === "ambiguous" ? [device, device] : [device],
                },
              },
      },
      mode === "ended"
        ? { success: false, error: "Session ended" }
        : { success: true, result: { ...info, assignedDevice: "recycled" } },
    );
    await expect(f.client.info("session")).rejects.toThrow();
    expect(f.sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  },
);

test("native info supports the daemon text envelope and iOS UDID", async () => {
  const f = fixture();
  const info = { sessionId: "session", assignedDevice: "udid", platform: "ios" };
  f.replies.push(
    { success: true, result: info },
    {
      success: true,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              devices: [{ name: "ambroker-ios", platform: "ios", runtime: { deviceId: "udid" } }],
            }),
          },
        ],
      },
    },
    { success: true, result: info },
  );
  expect(await f.client.info("session")).toMatchObject({
    nativeDevice: { deviceId: "udid", name: "ambroker-ios", platform: "ios" },
  });
});

test("connect and premature close failures are typed transport errors with causes", async () => {
  const timer = new FakeTimer();
  const cause = new Error("connection refused");
  const client = createFrameBrokerDaemonClient({
    socketPath: "/fake",
    timer,
    connect: async () => {
      throw cause;
    },
  });
  const error = await client.status("request", "secret").then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(BrokerTransportError);
  expect(error).toMatchObject({ name: "BrokerTransportError", cause });
  for (const cause of [undefined, new Error("reset")]) {
    const f = fixture();
    f.replies.push(undefined);
    const pending = f.client.status("request", "secret").then(
      () => null,
      (error: unknown) => error,
    );
    await drainUntilQuiescent(f.timer);
    f.sockets[0].close(cause);
    expect(await pending).toBeInstanceOf(BrokerTransportError);
    if (cause) {
      expect(await pending).toMatchObject({ cause });
    }
  }
});

test.each([true, false])(
  "release polling retries only transport errors (%s)",
  async (transport) => {
    const timer = new FakeTimer();
    const client = new FakeBrokerDaemonClient();
    const error = transport ? new BrokerTransportError("restarting") : new Error("refused");
    client.statusResults = [error, released];
    const pending = waitForBrokerRelease({
      client,
      requestId: "request",
      token: "secret",
      timer,
    }).then(
      (result) => result,
      (error: unknown) => error,
    );
    await drainUntilQuiescent(timer);
    if (transport) {
      timer.advanceTime(1000);
    }
    expect(await pending).toBe(transport ? released : error);
    expect(client.calls).toHaveLength(transport ? 2 : 1);
  },
);

test("transport retry sleeps only the remaining release budget", async () => {
  const timer = new FakeTimer();
  const client = new FakeBrokerDaemonClient();
  client.statusResults = [new BrokerTransportError("restarting")];
  const pending = waitForBrokerRelease({
    client,
    requestId: "request",
    token: "secret",
    timer,
    timeoutMs: 400,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  await drainUntilQuiescent(timer);
  timer.advanceTime(400);
  expect(await pending).toBeInstanceOf(Error);
  expect(client.calls).toHaveLength(1);
  expect(timer.now()).toBe(400);
});

test.each(["refused", "schema"])(
  "daemon %s errors remain outside transport retry classification",
  async (mode) => {
    const f = fixture();
    f.replies.push(
      mode === "refused" ? { success: false, error: "refused" } : { success: true, result: {} },
    );
    const error = await f.client.status("request", "secret").then(
      () => null,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BrokerTransportError);
  },
);
