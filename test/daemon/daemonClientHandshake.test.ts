import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../../src/daemon/client";
import type { DaemonRequest } from "../../src/daemon/types";

/**
 * Stand up a tiny Unix socket server that captures the first request line and
 * replies success, so we can assert what the DaemonClient puts on the wire.
 */
function startCapturingServer(socketPath: string): { server: Server; firstRequest: Promise<DaemonRequest> } {
  let resolveFirst: (req: DaemonRequest) => void;
  const firstRequest = new Promise<DaemonRequest>(resolve => {
    resolveFirst = resolve;
  });

  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const request = JSON.parse(line) as DaemonRequest;
        resolveFirst(request);
        socket.write(
          JSON.stringify({ id: request.id, type: "mcp_response", success: true, result: {} }) + "\n"
        );
      }
    });
  });

  return { server, firstRequest };
}

describe("DaemonClient handshake fields", () => {
  let socketPath: string;
  let server: Server;

  beforeEach(() => {
    socketPath = join(tmpdir(), `t-dch-${randomUUID().slice(0, 8)}.sock`);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("attaches injected clientVersion + build identity to tool calls", async () => {
    const capture = startCapturingServer(socketPath);
    server = capture.server;
    await new Promise<void>(resolve => server.listen(socketPath, resolve));

    const client = new DaemonClient(socketPath, 5000, undefined, {}, {
      version: "0.0.40+gtest",
      build: { entryScript: "/repo/dist/index.js", buildId: "clientbuild123" },
    });
    await client.connect();
    await client.callTool("observe", { platform: "android" });

    const request = await capture.firstRequest;
    expect(request.clientVersion).toBe("0.0.40+gtest");
    expect(request.clientBuildId).toBe("clientbuild123");
    expect(request.clientEntryScript).toBe("/repo/dist/index.js");
    await client.close();
  });

  test("attaches handshake fields to daemon method calls too", async () => {
    const capture = startCapturingServer(socketPath);
    server = capture.server;
    await new Promise<void>(resolve => server.listen(socketPath, resolve));

    const client = new DaemonClient(socketPath, 5000, undefined, {}, {
      version: "0.0.40",
      build: { entryScript: "/repo/dist/index.js", buildId: "clientbuild123" },
    });
    await client.connect();
    await client.callDaemonMethod("daemon/availableDevices", {});

    const request = await capture.firstRequest;
    expect(request.clientVersion).toBe("0.0.40");
    expect(request.clientBuildId).toBe("clientbuild123");
    await client.close();
  });
});
