import { FakeSocket } from "../fakes/FakeNetServer";
import * as net from "node:net";
import { describe, expect, mock, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";

let createdSocket: FakeSocket | undefined;
let failNextConnect = false;
mock.module("node:net", () => ({
  ...net,
  createConnection: (_socketPath: string, onConnect: () => void) => {
    const socket = new FakeSocket();
    createdSocket = socket;
    if (failNextConnect) {
      failNextConnect = false;
      queueMicrotask(() => socket.emit("error", new Error("connect ECONNREFUSED")));
    } else {
      queueMicrotask(onConnect);
    }
    return socket;
  },
}));

const { DaemonClient, DaemonRequestNotDeliveredError, DaemonUnavailableError } =
  await import("../../src/daemon/client");

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
