import { afterEach, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonResponse } from "../../src/daemon/types";
import type { DaemonSelfIdentity } from "../../src/daemon/daemonHandshake";

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({ getSession: () => null, releaseSession: async () => null }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

function sendRequest(
  socketPath: string,
  payload: Record<string, unknown>
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    let buffer = "";

    client.connect(socketPath, () => {
      client.write(JSON.stringify({ id: randomUUID(), ...payload }) + "\n");
    });

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line) as DaemonResponse;
            client.destroy();
            resolve(response);
            return;
          } catch {
            // keep buffering
          }
        }
      }
    });

    client.on("error", reject);
    client.on("close", () => {
      if (!buffer.trim()) {
        reject(new Error("Connection closed without response"));
      }
    });
  });
}

// `ide/ping` is handled locally without the MCP client, so these tests exercise the
// handshake gate without needing a live HTTP MCP backend.
const PING = { type: "mcp_request" as const, method: "ide/ping", params: {} };

describe("UnixSocketServer version/build-identity handshake gate", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  const daemonIdentity: DaemonSelfIdentity = {
    version: "0.0.40+gdaemon",
    build: { entryScript: "/repo/dist/index.js", buildId: "daemonbuild1234" },
  };

  async function startServer(enforce = true): Promise<void> {
    socketPath = join(tmpdir(), `t-hs-${randomUUID().slice(0, 8)}.sock`);
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      new FakeTimer(),
      null,
      { identity: daemonIdentity, enforce }
    );
    await server.start();
  }

  afterEach(async () => {
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("allows a legacy client that declares no handshake fields", async () => {
    await startServer();
    const response = await sendRequest(socketPath, PING);
    expect(response.success).toBe(true);
  });

  test("allows a client whose release version matches (ignoring git stamp)", async () => {
    await startServer();
    const response = await sendRequest(socketPath, { ...PING, clientVersion: "0.0.40" });
    expect(response.success).toBe(true);
  });

  test("rejects a client whose release version differs", async () => {
    await startServer();
    const response = await sendRequest(socketPath, { ...PING, clientVersion: "0.0.39" });
    expect(response.success).toBe(false);
    expect(response.error).toContain("version mismatch");
    expect(response.error).toContain("0.0.39");
  });

  test("rejects a same-release client with a different build id", async () => {
    await startServer();
    const response = await sendRequest(socketPath, {
      ...PING,
      clientVersion: "0.0.40",
      clientBuildId: "someotherbuild9",
      clientEntryScript: "/other/dist/index.js",
    });
    expect(response.success).toBe(false);
    expect(response.error).toContain("build mismatch");
  });

  test("allows a matching build id", async () => {
    await startServer();
    const response = await sendRequest(socketPath, {
      ...PING,
      clientVersion: "0.0.40",
      clientBuildId: "daemonbuild1234",
      clientEntryScript: "/repo/dist/index.js",
    });
    expect(response.success).toBe(true);
  });

  test("does not gate when enforcement is disabled", async () => {
    await startServer(false);
    const response = await sendRequest(socketPath, { ...PING, clientVersion: "0.0.39" });
    expect(response.success).toBe(true);
  });
});
