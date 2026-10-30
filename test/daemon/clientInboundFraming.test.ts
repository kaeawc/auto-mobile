import { expect, spyOn, test } from "bun:test";
import * as net from "node:net";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client/client";
import { ActionableError } from "../../src/models/ActionableError";
import { logger } from "../../src/utils/logger";
import type { DaemonNotification, DaemonResponse } from "../../src/daemon/types";
import { DaemonFrameTooLargeError } from "../../src/daemon/wire/DaemonFrameTooLargeError";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { DaemonDisconnectError } from "../../src/daemon/DaemonDisconnectError";
import { ISOLATED_DAEMON_RECOVERY } from "../helpers/isolatedDaemonRecovery";
import { connectionListenerOf } from "../helpers/netConnectionListener";

class RecordingDaemonClient extends DaemonClient {
  readonly received: DaemonResponse[] = [];

  protected override handleResponse(response: DaemonResponse): void {
    this.received.push(response);
    super.handleResponse(response);
  }
}

function setup(limit = 256) {
  const timer = new FakeTimer();
  const socket = new FakeSocket();
  const client = new RecordingDaemonClient(
    "/fake/socket",
    1000,
    timer,
    ISOLATED_DAEMON_RECOVERY,
    null,
    {
      idGenerator: new FakeIdGenerator(["p"]),
      platformOverride: "darwin",
      maxInboundFrameBytes: limit,
    },
  );
  client.testHooks.attachSocket(socket);
  const feed = (frame: unknown) =>
    client.testHooks.simulateIncomingData(Buffer.from(JSON.stringify(frame) + "\n"));
  const request = (signal?: AbortSignal) =>
    client.callTool("tapOn", {}, undefined, undefined, { signal }).catch((error: unknown) => error);
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
      client.testHooks.simulateIncomingData(Buffer.from("x".repeat(65) + (newline ? "\n" : "")));
      expect(socket.destroyed).toBe(true);
      const error = await first;
      expect(error.cause).toBeInstanceOf(ActionableError);
      expect(error).toBeInstanceOf(DaemonUnavailableError);
      expect(error.message).toStartWith("Daemon socket connection lost:");
      expect(error.cause).toBeInstanceOf(DaemonFrameTooLargeError);
      expect(error.cause.message).toContain("64 bytes");
      expect(await second).toMatchObject({ name: "DaemonUnavailableError", cause: error.cause });
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(remove).toHaveBeenCalled();
      expect(client.testHooks.connection().connected).toBe(false);
      expect(closes).toBe(1);
      client.testHooks.simulateIncomingData(Buffer.from("null\n" + "x".repeat(65)));
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
      client.testHooks.simulateIncomingData(
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
    const result = request();
    try {
      feed(shape);
      expect(client.testHooks.hasPendingRequest("p")).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(errors).not.toHaveBeenCalled();
      expect(client.received).toHaveLength(0);
      warn.mockClear();
      feed({
        ...(shape && typeof shape === "object" && !Array.isArray(shape) ? shape : {}),
        marker: "PRIVATE_TOOL_OUTPUT",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_TOOL_OUTPUT");
      expect(client.testHooks.hasPendingRequest("p")).toBe(true);
      expect(client.received).toHaveLength(0);
      feed({ id: "p", type: "mcp_response", success: true, result: "ok" });
      expect(await result).toBe("ok");
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await client.close();
      await result;
      warn.mockRestore();
      errors.mockRestore();
    }
  });
}

test("valid response preserves unknown and unchecked additive fields", async () => {
  const { client, request, feed } = setup(512);
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
    expect(client.received[0]).toEqual<unknown>(frame);
  } finally {
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
  const frame = { type: "daemon_notification" as const, method: "notice", extra: "😀" };
  const bytes = Buffer.from(JSON.stringify(frame) + "\n");
  const split = bytes.indexOf(Buffer.from("😀")) + 1;
  try {
    client.testHooks.simulateIncomingData(bytes.subarray(0, split));
    client.testHooks.simulateIncomingData(bytes.subarray(split));
    expect(received).toEqual([frame]);
    client.testHooks.simulateIncomingData(Buffer.from("x".repeat(129)));
    expect(socket.destroyed).toBe(true);
    const replacement = new FakeSocket();
    client.testHooks.attachSocket(replacement);
    await client.connect();
    client.testHooks.simulateIncomingData(bytes);
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
  const create = spyOn(net, "createConnection").mockImplementation((...args: unknown[]) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    callbacks.push(connectionListenerOf(args)!);
    return socket;
  });
  const client = new DaemonClient("/fake/socket", 1000, timer, ISOLATED_DAEMON_RECOVERY, null, {
    idGenerator: new FakeIdGenerator(["p", "q"]),
    platformOverride: "win32",
    maxInboundFrameBytes: 128,
  });
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

test("overflow preserves the frame error when a connection-closed handler closes the client", async () => {
  await withSocketConnection(async (client, sockets, callbacks, timer) => {
    const connecting = client.connect();
    callbacks[0]!();
    await connecting;
    const socket = sockets[0]!;
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    let closed = 0;
    client.onConnectionClosed(() => {
      closed++;
      void client.close();
    });
    const first = client
      .callTool("tapOn", {}, undefined, undefined, { signal: controller.signal })
      .catch((error: unknown) => error);
    const second = client.callTool("tapOn", {}).catch((error: unknown) => error);
    try {
      client.testHooks.simulateIncomingData(Buffer.from("x".repeat(129)));
      const error = await first;
      expect(error).toBeInstanceOf(DaemonUnavailableError);
      expect(error.cause).toBeInstanceOf(DaemonFrameTooLargeError);
      expect(await second).toMatchObject({ name: "DaemonUnavailableError", cause: error.cause });
      expect(client.testHooks.hasPendingRequest("p")).toBe(false);
      expect(client.testHooks.hasPendingRequest("q")).toBe(false);
      expect(socket.destroyed).toBe(true);
      expect(closed).toBe(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      socket.emit("close");
      client.testHooks.simulateIncomingData(Buffer.from("x".repeat(129)));
      expect(closed).toBe(1);
    } finally {
      remove.mockRestore();
    }
  });
});

test("overflow destroys the socket and rejects requests even when a connection-closed handler throws", async () => {
  await withSocketConnection(async (client, sockets, callbacks, timer) => {
    const connecting = client.connect();
    callbacks[0]!();
    await connecting;
    const socket = sockets[0]!;
    const handlerError = new Error("connection-closed handler failed");
    let closed = 0;
    const unsubscribe = client.onConnectionClosed(() => {
      closed++;
      throw handlerError;
    });
    const first = client.callTool("tapOn", {}).catch((error: unknown) => error);
    const second = client.callTool("tapOn", {}).catch((error: unknown) => error);
    try {
      expect(() => client.testHooks.simulateIncomingData(Buffer.from("x".repeat(129)))).toThrow(
        handlerError,
      );
      expect(socket.destroyed).toBe(true);
      const error = await first;
      expect(error).toBeInstanceOf(DaemonUnavailableError);
      expect(error.cause).toBeInstanceOf(DaemonFrameTooLargeError);
      expect(await second).toMatchObject({ name: "DaemonUnavailableError", cause: error.cause });
      expect(client.testHooks.hasPendingRequest("p")).toBe(false);
      expect(client.testHooks.hasPendingRequest("q")).toBe(false);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(closed).toBe(1);
      socket.emit("close");
      client.testHooks.simulateIncomingData(Buffer.from("x".repeat(129)));
      expect(closed).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});

test("test socket attachment adds no listeners", async () => {
  const socket = new FakeSocket();
  const client = new DaemonClient(
    "/fake/socket",
    1000,
    new FakeTimer(),
    ISOLATED_DAEMON_RECOVERY,
    null,
  );
  const listeners = socket.eventNames().map((event) => [event, socket.listeners(event)]);
  try {
    client.testHooks.attachSocket(socket);
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
        expect(client.testHooks.hasPendingRequest("p")).toBe(false);
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
        expect(client.testHooks.hasPendingRequest("q")).toBe(true);
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

for (const pendingCount of [1, 2]) {
  for (const head of [
    '{"id":"p","type":"mcp_response","success":true,"result":"',
    '{"id":"fake-1","type":"mcp_response","success":true,"result":"',
    '{"id":"not-pending","type":"mcp_response","success":true,"result":"',
    '{"type":"daemon_notification","method":"notice","data":"',
    '{"id":"unterminated',
    '{"id":"bad\\escape","result":"',
    '{"unterminated',
    '{"bad\\escape":"notice","data":"',
  ]) {
    test(`overflow attribution uses only a complete pending response id (${pendingCount} pending): ${head}`, async () => {
      const { client, timer, socket, request } = setup(128);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const first = request();
      const second = pendingCount === 2 ? request() : undefined;
      try {
        // Split the id itself across chunks, as a socket read may do.
        client.testHooks.simulateIncomingData(Buffer.from(head.slice(0, 5)));
        client.testHooks.simulateIncomingData(Buffer.from(head.slice(5) + "x".repeat(129)));
        const firstAnswer = await first;
        if (pendingCount === 1) {
          const unreadable = [
            '{"id":"unterminated',
            '{"id":"bad\\escape","result":"',
            '{"unterminated',
            '{"bad\\escape":"notice","data":"',
          ].includes(head);
          if (head.startsWith('{"id":"p"') || unreadable) {
            expect(firstAnswer).toBeInstanceOf(DaemonFrameTooLargeError);
          } else {
            expect(firstAnswer).toBeInstanceOf(DaemonUnavailableError);
            expect(firstAnswer.cause).toBeInstanceOf(DaemonFrameTooLargeError);
          }
          expect(timer.getPendingTimeoutCount()).toBe(0);
          expect(socket.destroyed).toBe(true);
          return;
        }
        const secondAnswer = await second;
        const ownsSecond = head.startsWith('{"id":"fake-1"');
        const owner = ownsSecond ? secondAnswer : firstAnswer;
        const sibling = ownsSecond ? firstAnswer : secondAnswer;
        expect(sibling).toBeInstanceOf(DaemonUnavailableError);
        expect(sibling.message).toStartWith("Daemon socket connection lost:");
        expect(sibling.cause).toBeInstanceOf(DaemonFrameTooLargeError);
        if (head.startsWith('{"id":"p"') || ownsSecond) {
          expect(owner).toBeInstanceOf(DaemonFrameTooLargeError);
          expect(sibling.cause).toBe(owner);
        } else {
          expect(owner).toBeInstanceOf(DaemonUnavailableError);
          expect(owner.cause).toBe(sibling.cause);
        }
        expect(timer.getPendingTimeoutCount()).toBe(0);
        expect(socket.destroyed).toBe(true);
      } finally {
        await client.close();
        warn.mockRestore();
      }
    });
  }
}

test("one pending call keeps the frame error for an unattributed overflow", async () => {
  const { client, request } = setup(64);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const result = request();
  try {
    client.testHooks.simulateIncomingData(Buffer.from("x".repeat(65)));
    expect(await result).toBeInstanceOf(DaemonFrameTooLargeError);
  } finally {
    await client.close();
    warn.mockRestore();
  }
});
