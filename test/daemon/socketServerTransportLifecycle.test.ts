import type { Socket } from "node:net";
import { describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

interface ServerInternals {
  mcpClients: Map<string, Client>;
  resetMcpClient(key: string): Promise<void>;
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  handleRequest(
    sessionId: string,
    socket: Socket,
    request: DaemonRequest,
    receivedAtMs: number,
  ): Promise<DaemonResponse>;
}

class RpcSocket extends FakeSocket {
  setTimeout(_ms: number): this {
    return this;
  }
}

describe("daemon socket transport lifecycle", () => {
  test("reset sends HTTP DELETE before closing the loopback MCP client", async () => {
    const server = new UnixSocketServer(
      "/fake/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      new FakeTimer(),
    );
    const internals = server as unknown as ServerInternals;
    const events: string[] = [];
    const transport = Object.create(
      StreamableHTTPClientTransport.prototype,
    ) as StreamableHTTPClientTransport;
    Object.defineProperty(transport, "sessionId", { value: "http-session" });
    transport.terminateSession = async () => {
      events.push("DELETE");
    };
    const client = {
      transport,
      close: async () => {
        events.push("close");
      },
    } as unknown as Client;
    internals.mcpClients.set("device:a", client);

    await internals.resetMcpClient("device:a");

    expect(events).toEqual(["DELETE", "close"]);
    expect(internals.mcpClients.size).toBe(0);
  });

  test("a stalled HTTP DELETE cannot block client close indefinitely", async () => {
    const timer = new FakeTimer();
    const server = new UnixSocketServer("/fake/socket", "http://127.0.0.1:1/mcp", undefined, timer);
    const internals = server as unknown as ServerInternals;
    let closed = false;
    const transport = Object.create(
      StreamableHTTPClientTransport.prototype,
    ) as StreamableHTTPClientTransport;
    Object.defineProperty(transport, "sessionId", { value: "http-session" });
    transport.terminateSession = () => new Promise<void>(() => {});
    internals.mcpClients.set("device:a", {
      transport,
      close: async () => {
        closed = true;
      },
    } as unknown as Client);

    const reset = internals.resetMcpClient("device:a");
    await Promise.resolve();
    await Promise.resolve();
    timer.advanceTime(2_000);
    await reset;
    expect(closed).toBeTrue();
  });

  test("daemon RPC reader preserves UTF-8 split across socket events", async () => {
    const server = new UnixSocketServer(
      "/fake/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      new FakeTimer(),
    );
    const internals = server as unknown as ServerInternals;
    const socket = new RpcSocket();
    const requests: DaemonRequest[] = [];
    internals.acceptingRequests = true;
    internals.handleRequest = async (_sessionId, _socket, request) => {
      requests.push(request);
      return { id: request.id, type: "mcp_response", success: true, result: "ok" };
    };
    internals.handleConnection(socket as unknown as Socket);
    const frame = Buffer.from(
      JSON.stringify({
        id: "1",
        type: "daemon_request",
        method: "tools/list",
        params: { text: "日" },
      }) + "\n",
    );
    const split = frame.indexOf(Buffer.from("日")) + 1;
    socket.emit("data", frame.subarray(0, split));
    socket.emit("data", frame.subarray(split));
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toEqual({ text: "日" });
  });
});
