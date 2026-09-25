import { EventEmitter } from "node:events";
import * as net from "node:net";
import { describe, expect, mock, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: string[] = [];

  write(chunk: string): void {
    this.writes.push(chunk);
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

let createdSocket: FakeSocket | undefined;
mock.module("node:net", () => ({
  ...net,
  createConnection: (_socketPath: string, onConnect: () => void) => {
    createdSocket = new FakeSocket();
    queueMicrotask(onConnect);
    return createdSocket;
  },
}));

const { DaemonClient, DaemonUnavailableError } = await import("../../src/daemon/client");
const { DaemonDisconnectError } = await import("../../src/daemon/DaemonDisconnectError");

describe("DaemonClient socket error disconnect cause", () => {
  test("surfaces a disconnect cause on each pending request on transport error", async () => {
    const client = new DaemonClient(
      "/fake/socket",
      1_000,
      new FakeTimer(),
      {},
      null,
      undefined,
      "win32",
    );
    await client.connect();

    const request = client.callDaemonMethod("tools/list", {}, { timeoutMs: 250 });
    const transportError = new Error("read ECONNRESET");
    (transportError as NodeJS.ErrnoException).code = "ECONNRESET";
    createdSocket!.emit("error", transportError);

    try {
      await request;
      expect.unreachable("the pending request should reject");
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonUnavailableError);
      expect((error as DaemonUnavailableError).cause).toBeInstanceOf(DaemonDisconnectError);
      const disconnectCause = (error as DaemonUnavailableError).cause as DaemonDisconnectError;
      expect(disconnectCause.toolName).toBe("tools/list");
    }
  });
});
