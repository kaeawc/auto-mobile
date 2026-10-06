import { FakeSocket } from "../fakes/FakeNetServer";
import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";

let createdSocket: FakeSocket | undefined;
let failNextConnect = false;
let createConnectionSpy: ReturnType<typeof spyOn<typeof net, "createConnection">>;

beforeEach(() => {
  createdSocket = undefined;
  failNextConnect = false;
  createConnectionSpy = spyOn(net, "createConnection").mockImplementation((_path, onConnect) => {
    const socket = new FakeSocket();
    createdSocket = socket;
    if (failNextConnect) {
      failNextConnect = false;
      queueMicrotask(() => socket.emit("error", new Error("connect ECONNREFUSED")));
    } else {
      queueMicrotask(onConnect!);
    }
    return socket as unknown as net.Socket;
  });
});

afterEach(() => {
  createdSocket?.destroy();
  createConnectionSpy.mockRestore();
});

import {
  DaemonClient,
  DaemonRequestNotDeliveredError,
  DaemonUnavailableError,
} from "../../src/daemon/client";

function createClient() {
  return new DaemonClient("/fake/socket", 1_000, new FakeTimer(), {}, null, undefined, "win32");
}

// Issue #6382: the proxy may replay a mutating tools/call only when the client
// proves the request frame never reached the socket.
describe("DaemonClient request delivery phase", () => {
  test("a connect failure before the frame is written is typed as not delivered", async () => {
    const client = createClient();
    failNextConnect = true;

    const call = client.callTool("tapOn", { text: "Submit" });

    await expect(call).rejects.toBeInstanceOf(DaemonRequestNotDeliveredError);
    expect(createdSocket!.writes).toEqual([]);
  });

  test("a socket close after the frame is written stays an ambiguous transport loss", async () => {
    const client = createClient();
    await client.connect();

    const call = client.callTool("tapOn", { text: "Submit" });
    await Promise.resolve();
    expect(createdSocket!.writes).toHaveLength(1);
    createdSocket!.emit("close");

    const error = await call.then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(DaemonUnavailableError);
    expect(error).not.toBeInstanceOf(DaemonRequestNotDeliveredError);
  });
});

// A throw between scheduling the request timeout and writing the frame used to
// leave the timer and pending entry behind until the timeout fired.
describe("DaemonClient request that fails before the frame is written", () => {
  function createTimedClient() {
    const timer = new FakeTimer();
    const client = new DaemonClient("/fake/socket", 1_000, timer, {}, null, undefined, "win32");
    return { client, timer };
  }

  test("a synchronous socket write failure clears the timer and is typed as not delivered", async () => {
    const { client, timer } = createTimedClient();
    await client.connect();
    const baselineTimers = timer.getPendingTimeouts().length;
    createdSocket!.write = () => {
      throw new Error("write exploded");
    };

    const error = await client.callTool("tapOn", { text: "Submit" }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(DaemonRequestNotDeliveredError);
    expect(timer.getPendingTimeouts()).toHaveLength(baselineTimers);
  });

  test("an unserializable argument rejects with its own error and schedules nothing", async () => {
    const { client, timer } = createTimedClient();
    await client.connect();
    const baselineTimers = timer.getPendingTimeouts().length;

    const error = await client.callTool("tapOn", { count: BigInt(1) }).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(createdSocket!.writes).toEqual([]);
    expect(timer.getPendingTimeouts()).toHaveLength(baselineTimers);
  });
});
