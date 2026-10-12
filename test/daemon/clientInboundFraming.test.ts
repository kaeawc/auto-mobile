import { expect, spyOn, test } from "bun:test";
import * as net from "node:net";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client";
import { ActionableError } from "../../src/models/ActionableError";
import { logger } from "../../src/utils/logger";
import type { DaemonNotification, DaemonResponse } from "../../src/daemon/types";
import { DaemonFrameTooLargeError } from "../../src/daemon/socketServer/LineFramer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { DaemonDisconnectError } from "../../src/daemon/DaemonDisconnectError";

function setup(limit = 256) {
  const timer = new FakeTimer();
  const socket = new FakeSocket();
  const client = new DaemonClient(
    "/fake/socket",
    1000,
    timer,
    {},
    null,
    new FakeIdGenerator(["p"]),
    "darwin",
    limit,
  );
  client.attachSocketForTesting(socket);
  const feed = (frame: unknown) =>
    client.simulateIncomingDataForTesting(Buffer.from(JSON.stringify(frame) + "\n"));
  const request = (signal?: AbortSignal) =>
    client.callTool("tapOn", {}, undefined, undefined, signal).catch((error: unknown) => error);
  return { client, timer, socket, feed, request };
}

for (const newline of [false, true]) {
  test(`oversized ${newline ? "terminated" : "unterminated"} frame closes the connection and rejects all requests`, async () => {
    const { client, timer, socket, request } = setup(64);
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    let closes = 0;
    client.onConnectionClosed(() => closes++);
    const first = request(controller.signal);
    const second = request();
    try {
      client.simulateIncomingDataForTesting(Buffer.from("x".repeat(65) + (newline ? "\n" : "")));
      expect(socket.destroyed).toBe(true);
      const error = await first;
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).not.toBeInstanceOf(DaemonUnavailableError);
      expect(error).toBeInstanceOf(DaemonFrameTooLargeError);
      expect(error.message).toContain("64 bytes");
      expect(await second).toBe(error);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(remove).toHaveBeenCalled();
      expect((client as unknown as { connected: boolean }).connected).toBe(false);
      expect(closes).toBe(1);
      client.simulateIncomingDataForTesting(Buffer.from("null\n" + "x".repeat(65)));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(closes).toBe(1);
    } finally {
      await client.close();
      await first;
      await second;
      remove.mockRestore();
      warn.mockRestore();
    }
  });
}

for (const extraByte of [false, true]) {
  test(`frame at the limit ${extraByte ? "plus one is rejected" : "is delivered"}`, async () => {
    const frame = { id: "p", type: "mcp_response", success: true, result: "ok" };
    const serialized = JSON.stringify(frame);
    const { client, socket, request } = setup(Buffer.byteLength(serialized));
    const result = request();
    try {
      client.simulateIncomingDataForTesting(
        Buffer.from(serialized + (extraByte ? " " : "") + "\n"),
      );
      if (extraByte) {
        expect(socket.destroyed).toBe(true);
        expect(await result).toBeInstanceOf(DaemonFrameTooLargeError);
      } else {
        expect(await result).toBe("ok");
        expect(socket.destroyed).toBe(false);
      }
    } finally {
      await client.close();
      await result;
    }
  });
}

const wrongShapes = [
  null,
  42,
  [],
  {},
  { id: null },
  { id: "p" },
  { id: "p", type: "mcp_response" },
  { type: "mcp_response", id: 7, success: true },
];
for (const [index, shape] of wrongShapes.entries()) {
  test(`wrong-shape frame ${index} is dropped without settling or exposing payload`, async () => {
    const { client, timer, request, feed } = setup();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    const receiver = spyOn(
      client as unknown as { handleResponse(response: DaemonResponse): void },
      "handleResponse",
    );
    const result = request();
    try {
      feed(shape);
      expect(client.hasPendingRequestForTesting("p")).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(errors).not.toHaveBeenCalled();
      expect(receiver).not.toHaveBeenCalled();
      warn.mockClear();
      feed({
        ...(shape && typeof shape === "object" && !Array.isArray(shape) ? shape : {}),
        marker: "PRIVATE_TOOL_OUTPUT",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_TOOL_OUTPUT");
      expect(client.hasPendingRequestForTesting("p")).toBe(true);
      expect(receiver).not.toHaveBeenCalled();
      feed({ id: "p", type: "mcp_response", success: true, result: "ok" });
      expect(await result).toBe("ok");
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await client.close();
      await result;
      warn.mockRestore();
      errors.mockRestore();
      receiver.mockRestore();
    }
  });
}

test("valid response preserves unknown and unchecked additive fields", async () => {
  const { client, request, feed } = setup(512);
  const receiver = spyOn(
    client as unknown as { handleResponse(response: DaemonResponse): void },
    "handleResponse",
  );
  const result = request();
  const frame = {
    id: "p",
    type: "mcp_response",
    success: true,
    result: "ok",
    extra: "kept",
    code: [],
    retryable: "future",
    details: 42,
    releaseReason: {},
  };
  try {
    feed(frame);
    expect(await result).toBe("ok");
    expect(receiver.mock.calls[0]?.[0]).toEqual(frame);
  } finally {
    receiver.mockRestore();
    await client.close();
    await result;
  }
});

test("valid null-id parse refusal still rejects the sole pending request", async () => {
  const { client, request, feed } = setup();
  const result = request();
  try {
    feed({ id: null, type: "mcp_response", success: false, error: "parse refused" });
    expect(await result).toBeInstanceOf(ActionableError);
    expect((await result).message).toBe("parse refused");
  } finally {
    await client.close();
    await result;
  }
});

test("notification preserves extras and split UTF-8, and a replacement connection gets a fresh framer", async () => {
  const { client, socket } = setup(128);
  const received: DaemonNotification[] = [];
  client.onNotification((frame) => received.push(frame));
  const frame = { type: "daemon_notification", method: "notice", extra: "😀" };
  const bytes = Buffer.from(JSON.stringify(frame) + "\n");
  const split = bytes.indexOf(Buffer.from("😀")) + 1;
  try {
    client.simulateIncomingDataForTesting(bytes.subarray(0, split));
    client.simulateIncomingDataForTesting(bytes.subarray(split));
    expect(received).toEqual([frame]);
    client.simulateIncomingDataForTesting(Buffer.from("x".repeat(129)));
    expect(socket.destroyed).toBe(true);
    const replacement = new FakeSocket();
    client.attachSocketForTesting(replacement);
    await client.connect();
    client.simulateIncomingDataForTesting(bytes);
    expect(received).toEqual([frame, frame]);
  } finally {
    await client.close();
  }
});

async function withSocketConnection(
  scenario: (
    client: DaemonClient,
    sockets: FakeSocket[],
    callbacks: Array<() => void>,
    timer: FakeTimer,
  ) => Promise<void>,
): Promise<void> {
  const timer = new FakeTimer();
  const sockets: FakeSocket[] = [];
  const callbacks: Array<() => void> = [];
  const create = spyOn(net, "createConnection").mockImplementation((_path, callback) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    callbacks.push(callback!);
    return socket;
  });
  const client = new DaemonClient(
    "/fake/socket",
    1000,
    timer,
    {},
    null,
    new FakeIdGenerator(["p", "q"]),
    "win32",
    128,
  );
  try {
    await scenario(client, sockets, callbacks, timer);
  } finally {
    for (const socket of sockets) {
      socket.emit("close");
      socket.destroy();
    }
    await client.close();
    create.mockRestore();
  }
}

test("test socket attachment adds no listeners", async () => {
  const socket = new FakeSocket();
  const client = new DaemonClient("/fake/socket", 1000, new FakeTimer(), {}, null);
  const listeners = socket.eventNames().map((event) => [event, socket.listeners(event)]);
  try {
    client.attachSocketForTesting(socket);
    expect(socket.eventNames().map((event) => [event, socket.listeners(event)])).toEqual(listeners);
  } finally {
    await client.close();
  }
});

test("connect rejects a destroyed socket error without advancing fake time", async () => {
  await withSocketConnection(async (client, sockets, _callbacks, timer) => {
    const controller = new AbortController();
    const connecting = client.connect(1000, controller.signal).catch((error: unknown) => error);
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const socket = sockets[0]!;
      socket.destroyed = true;
      const transportError = new Error("connect ENOENT");
      socket.emit("error", transportError);
      const outcome = await Promise.race([connecting, drainMicrotasks(16).then(() => "unsettled")]);
      expect(outcome).toBeInstanceOf(DaemonUnavailableError);
      expect(outcome).toHaveProperty("message", "Daemon socket connection lost: connect ENOENT");
      expect(outcome).toHaveProperty("cause", transportError);
      expect(errors).toHaveBeenCalledWith("Daemon socket error: connect ENOENT");
      expect(timer.now()).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      controller.abort(new Error("test cleanup"));
      await connecting;
      errors.mockRestore();
    }
  });
});

test("established destroyed socket preserves transport error before close and notifies once", async () => {
  await withSocketConnection(async (client, sockets, callbacks, timer) => {
    const connecting = client.connect();
    callbacks[0]!();
    await connecting;
    let closed = 0;
    client.onConnectionClosed(() => closed++);
    const pending = client.callDaemonMethod("tools/list", {}).catch((error: unknown) => error);
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const socket = sockets[0]!;
      socket.destroyed = true;
      socket.emit("error", new Error("read ECONNRESET"));
      socket.emit("close");
      const error = await pending;
      expect(error).toBeInstanceOf(DaemonUnavailableError);
      expect(error).toHaveProperty("message", "Daemon socket connection lost: read ECONNRESET");
      expect(error.cause).toBeInstanceOf(DaemonDisconnectError);
      expect(error.cause.toolName).toBe("tools/list");
      expect(errors).toHaveBeenCalledWith("Daemon socket error: read ECONNRESET");
      expect(closed).toBe(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });
});

test("plain close notifies once", async () => {
  await withSocketConnection(async (client, sockets, callbacks) => {
    const connecting = client.connect();
    callbacks[0]!();
    await connecting;
    let closed = 0;
    client.onConnectionClosed(() => closed++);
    sockets[0]!.destroy();
    expect(closed).toBe(1);
    sockets[0]!.emit("close");
    expect(closed).toBe(1);
  });
});

for (const reconnectBeforeClose of [false, true]) {
  test(`overflow notifies synchronously once with old close ${reconnectBeforeClose ? "after" : "before"} reconnect`, async () => {
    await withSocketConnection(async (client, sockets, callbacks, timer) => {
      const connecting = client.connect();
      callbacks[0]!();
      await connecting;
      const socket = sockets[0]!;
      // Suppress FakeSocket's synchronous destroy-close; emit the close explicitly later.
      const destroy = spyOn(socket, "destroy").mockImplementation(() => {
        socket.destroyed = true;
        socket.writable = false;
        return socket;
      });
      let closed = 0;
      const unsubscribe = client.onConnectionClosed(() => {
        closed++;
        expect(socket.destroyed).toBe(false);
        expect(client.hasPendingRequestForTesting("p")).toBe(true);
      });
      const otherData = () => {};
      socket.on("data", otherData);
      const pending = client.callTool("tapOn", {}).catch((error: unknown) => error);
      try {
        socket.feed(Buffer.from("x".repeat(129)));
        expect(closed).toBe(1);
        expect(socket.destroyed).toBe(true);
        expect(socket.listeners("data")).toContain(otherData);
        expect(await pending).toBeInstanceOf(DaemonFrameTooLargeError);
        expect(timer.getPendingTimeoutCount()).toBe(0);
        if (!reconnectBeforeClose) {
          socket.emit("close");
          expect(closed).toBe(1);
        }
        const reconnect = client.connect();
        callbacks[1]!();
        await reconnect;
        const result = client.callTool("tapOn", {}).catch((error: unknown) => error);
        const bytes = Buffer.from(
          JSON.stringify({ type: "mcp_response", id: "q", success: true, result: "😀" }) + "\n",
        );
        const split = bytes.indexOf(Buffer.from("😀")) + 1;
        sockets[1]!.feed(bytes.subarray(0, split));
        socket.emit("data", Buffer.from("old socket data\n"));
        socket.emit("error", new Error("late socket error"));
        if (reconnectBeforeClose) {
          socket.emit("close");
        }
        expect(client.hasPendingRequestForTesting("q")).toBe(true);
        expect(closed).toBe(1);
        sockets[1]!.feed(bytes.subarray(split));
        expect(await result).toBe("😀");
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        unsubscribe();
        destroy.mockRestore();
      }
    });
  });
}
