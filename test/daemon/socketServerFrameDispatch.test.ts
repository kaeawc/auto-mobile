import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, test } from "bun:test";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly responses: DaemonResponse[] = [];

  setTimeout(): this {
    return this;
  }

  write(frame: string): boolean {
    this.responses.push(JSON.parse(frame) as DaemonResponse);
    // A named pipe may report backpressure. That must not hold the next
    // device's response behind a running call.
    return false;
  }

  send(request: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  }
}

test("a later pipe data event answers another device while the first call is held", async () => {
  const timer = new FakeTimer();
  const server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    {} as DaemonStateAccess,
    timer,
  );
  const first = Promise.withResolvers<DaemonResponse>();
  const firstStarted = Promise.withResolvers<void>();
  const socket = new FakeSocket();
  const request = (id: string, deviceId: string): DaemonRequest => ({
    id,
    type: "mcp_request",
    method: "tools/call",
    params: { name: "tapOn", arguments: { deviceId } },
  });
  (
    server as unknown as {
      handleRequest: (
        sessionId: string,
        socket: Socket,
        frame: DaemonRequest,
      ) => Promise<DaemonResponse>;
    }
  ).handleRequest = async (_sessionId, _socket, frame) => {
    if (frame.id === "first") {
      firstStarted.resolve();
      return first.promise;
    }
    return { id: frame.id, type: "mcp_response", success: true, result: {} };
  };
  (server as unknown as { acceptingRequests: boolean }).acceptingRequests = true;
  (server as unknown as { handleConnection: (socket: Socket) => void }).handleConnection(
    socket as unknown as Socket,
  );

  socket.send(request("first", "device-1"));
  await firstStarted.promise;
  socket.send(request("second", "device-2"));
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
  }
  expect(socket.responses.map((response) => response.id)).toEqual(["second"]);

  first.resolve({ id: "first", type: "mcp_response", success: true, result: {} });
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
  }
  expect(socket.responses.map((response) => response.id)).toEqual(["second", "first"]);
});
