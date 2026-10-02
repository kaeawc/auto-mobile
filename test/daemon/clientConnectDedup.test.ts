import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as net from "node:net";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

class DeferredSocket extends FakeSocket {
  constructor(private readonly onConnect: () => void) {
    super();
  }

  completeConnect(): void {
    this.onConnect();
  }
}

const sockets: DeferredSocket[] = [];
mock.module("node:net", () => ({
  ...net,
  createConnection: (_socketPath: string, onConnect: () => void) => {
    const socket = new DeferredSocket(onConnect);
    sockets.push(socket);
    return socket;
  },
}));

const { DaemonClient, DaemonUnavailableError } = await import("../../src/daemon/client");

let timer: FakeTimer;
let client: InstanceType<typeof DaemonClient>;

beforeEach(() => {
  sockets.length = 0;
  timer = new FakeTimer();
  client = new DaemonClient("/fake/socket", 1_000, timer, {}, null, undefined, "win32");
});

afterEach(async () => {
  // Settle any attempt left by a failed assertion without real timers or sockets.
  timer.advanceTime(5_000);
  await client.close();
  for (const socket of sockets) {
    socket.destroy();
  }
});

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

async function connectAndReplace() {
  const initial = client.connect();
  const oldSocket = sockets[0];
  oldSocket.completeConnect();
  await initial;
  let closedCount = 0;
  client.onConnectionClosed(() => closedCount++);
  oldSocket.emit("close");
  const reconnect = client.connect();
  const newSocket = sockets[1];
  newSocket.completeConnect();
  await reconnect;
  return { oldSocket, newSocket, closedCount: () => closedCount };
}

function connectionState() {
  return client as unknown as {
    readonly socket: net.Socket | null;
    readonly connected: boolean;
  };
}

function responseFrame(id: string, result: string): Buffer {
  return Buffer.from(JSON.stringify({ id, type: "mcp_response", success: true, result }) + "\n");
}

describe("DaemonClient connect deduplication and socket ownership", () => {
  test("concurrent connects share one socket and release the slot after success", async () => {
    const first = observe(client.connect());
    const second = observe(client.connect());
    const attemptSocketCount = sockets.length;
    for (const socket of sockets) {
      socket.completeConnect();
    }
    expect(await first).toEqual({ status: "fulfilled", value: undefined });
    expect(await second).toEqual({ status: "fulfilled", value: undefined });
    sockets.at(-1)!.emit("close");
    const reconnect = client.connect();
    sockets.at(-1)!.completeConnect();
    await reconnect;
    expect(attemptSocketCount).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a failed shared attempt rejects joiners with the same typed error and can retry", async () => {
    const first = observe(client.connect());
    const second = observe(client.connect());
    const attemptSocketCount = sockets.length;
    for (const socket of sockets) {
      socket.emit("error", new Error("connect ECONNREFUSED"));
    }
    const firstOutcome = await first;
    const secondOutcome = await second;
    const retry = client.connect();
    sockets.at(-1)!.completeConnect();
    await retry;
    expect(firstOutcome.status).toBe("rejected");
    expect(secondOutcome.status).toBe("rejected");
    if (firstOutcome.status === "rejected" && secondOutcome.status === "rejected") {
      expect(firstOutcome.reason).toBeInstanceOf(DaemonUnavailableError);
      expect(secondOutcome.reason).toBe(firstOutcome.reason);
    }
    expect(attemptSocketCount).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an initiating timeout rejects all joiners and releases the slot", async () => {
    const first = observe(client.connect(100));
    const second = observe(client.connect(1_000));
    timer.advanceTime(100);
    const firstOutcome = await first;
    // The unfixed client leaves its second attempt pending until its own timeout.
    timer.advanceTime(900);
    const secondOutcome = await second;
    expect(firstOutcome.status).toBe("rejected");
    expect(secondOutcome.status).toBe("rejected");
    if (firstOutcome.status === "rejected" && secondOutcome.status === "rejected") {
      expect(firstOutcome.reason).toBeInstanceOf(DaemonUnavailableError);
      expect(firstOutcome.reason).toHaveProperty(
        "message",
        "Failed to connect to daemon within 100ms",
      );
      expect(secondOutcome.reason).toBe(firstOutcome.reason);
    }
    const retry = client.connect();
    sockets.at(-1)!.completeConnect();
    await retry;
    expect(sockets).toHaveLength(2);
  });

  test("an already aborted initiating attempt does not poison a later connect", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel initiating connect");
    controller.abort(reason);
    const first = observe(client.connect(1_000, controller.signal));
    const second = observe(client.connect());
    // Complete any extra socket the old implementation incorrectly creates.
    for (const socket of sockets) {
      socket.completeConnect();
    }
    const firstOutcome = await first;
    const secondOutcome = await second;
    expect(firstOutcome.status).toBe("rejected");
    expect(secondOutcome.status).toBe("rejected");
    if (firstOutcome.status === "rejected" && secondOutcome.status === "rejected") {
      expect(firstOutcome.reason).toHaveProperty("cause", reason);
      expect(secondOutcome.reason).toBe(firstOutcome.reason);
    }
    const retry = client.connect();
    sockets.at(-1)!.completeConnect();
    await retry;
    expect(sockets).toHaveLength(1);
  });

  test("the initiating signal cancels the shared attempt and a late connect cannot revive it", async () => {
    const controller = new AbortController();
    const first = observe(client.connect(1_000, controller.signal));
    const second = observe(client.connect());
    const reason = new Error("cancel shared connect");
    timer.advanceTime(10);
    controller.abort(reason);
    const firstOutcome = await first;
    // Also settle the unfixed implementation's orphaned attempt in fake time.
    timer.advanceTime(990);
    const secondOutcome = await second;
    expect(firstOutcome.status).toBe("rejected");
    expect(secondOutcome.status).toBe("rejected");
    if (firstOutcome.status === "rejected" && secondOutcome.status === "rejected") {
      expect(firstOutcome.reason).toBeInstanceOf(DaemonUnavailableError);
      expect(firstOutcome.reason).toHaveProperty("cause", reason);
      expect(secondOutcome.reason).toBe(firstOutcome.reason);
    }
    expect(sockets[0].destroyed).toBe(true);
    sockets[0].completeConnect();
    expect(connectionState().connected).toBe(false);
    const retry = client.connect();
    sockets.at(-1)!.completeConnect();
    await retry;
    expect(sockets).toHaveLength(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  for (const event of ["close", "error"] as const) {
    test(`a stale ${event} leaves the live socket and its pending request intact`, async () => {
      const { oldSocket, newSocket, closedCount } = await connectAndReplace();
      const response = observe(client.callDaemonMethod("tools/list", {}, { timeoutMs: 250 }));
      const [{ id }] = newSocket.getWrittenMessages<{ id: string }>();
      const frame = responseFrame(id, "日");
      const split = frame.indexOf(Buffer.from("日")) + 1;
      newSocket.emit("data", frame.subarray(0, split));
      oldSocket.emit(event, new Error("late ECONNRESET"));
      expect(connectionState().socket).toBe(newSocket);
      expect(connectionState().connected).toBe(true);
      expect(newSocket.destroyed).toBe(false);
      expect(closedCount()).toBe(1);
      expect(client.hasPendingRequestForTesting(id)).toBe(true);
      newSocket.emit("data", frame.subarray(split));
      expect(await response).toEqual({ status: "fulfilled", value: "日" });
    });
  }

  test("stale data cannot complete a live request or corrupt its buffer and decoder", async () => {
    const { oldSocket, newSocket } = await connectAndReplace();
    const response = observe(client.callDaemonMethod("tools/list", {}, { timeoutMs: 250 }));
    const [{ id }] = newSocket.getWrittenMessages<{ id: string }>();
    oldSocket.emit("data", responseFrame(id, "stale"));
    expect(client.hasPendingRequestForTesting(id)).toBe(true);
    const frame = responseFrame(id, "日");
    const split = frame.indexOf(Buffer.from("日")) + 1;
    newSocket.emit("data", frame.subarray(0, split));
    oldSocket.emit("data", Buffer.from("stale incomplete frame"));
    newSocket.emit("data", frame.subarray(split));
    expect(await response).toEqual({ status: "fulfilled", value: "日" });
  });

  test("a current socket error still notifies connection-closed handlers", async () => {
    const connect = client.connect();
    sockets[0].completeConnect();
    await connect;
    let closedCount = 0;
    client.onConnectionClosed(() => closedCount++);
    sockets[0].emit("error", new Error("read ECONNRESET"));
    expect(closedCount).toBe(1);
    expect(connectionState().socket).toBeNull();
    expect(connectionState().connected).toBe(false);
  });

  test("a joiner's own deadline releases it without cancelling the shared attempt", async () => {
    const initiating = observe(client.connect(1_000));
    timer.advanceTime(20);
    let joinerSettled = false;
    const joiner = observe(client.connect(30)).then((outcome) => {
      joinerSettled = true;
      return outcome;
    });
    timer.advanceTime(29);
    await Promise.resolve();
    expect(joinerSettled).toBe(false);
    expect(sockets[0].destroyed).toBe(false);
    timer.advanceTime(1);
    const outcome = await joiner;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(DaemonUnavailableError);
      expect(outcome.reason).toHaveProperty("message", "Failed to connect to daemon within 30ms");
    }
    expect(timer.now()).toBe(50);
    expect(sockets[0].destroyed).toBe(false);
    sockets[0].completeConnect();
    expect(await initiating).toEqual({ status: "fulfilled", value: undefined });
    expect(sockets).toHaveLength(1);
    expect(connectionState().connected).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  for (const alreadyAborted of [false, true]) {
    test(`a ${alreadyAborted ? "pre-aborted" : "later-aborted"} joiner cannot cancel the shared attempt`, async () => {
      const initiating = observe(client.connect());
      const controller = new AbortController();
      const reason = new Error("cancel joiner only");
      if (alreadyAborted) {
        controller.abort(reason);
      }
      const joiner = observe(client.connect(100, controller.signal));
      if (!alreadyAborted) {
        timer.advanceTime(10);
        controller.abort(reason);
      }
      const outcome = await joiner;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(DaemonUnavailableError);
        expect(outcome.reason).toHaveProperty("message", "Daemon connection attempt aborted");
        expect(outcome.reason).toHaveProperty("cause", reason);
      }
      expect(sockets[0].destroyed).toBe(false);
      sockets[0].completeConnect();
      expect(await initiating).toEqual({ status: "fulfilled", value: undefined });
      expect(sockets).toHaveLength(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
  }
});
