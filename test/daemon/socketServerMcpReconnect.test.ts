import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { SOCKET_REQUEST_DEADLINE_MS, sendSocketRequest } from "./helpers/socketRequest";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonResponse } from "../../src/daemon/types";

/**
 * Minimal fake MCP client interface for testing.
 * Only implements the methods exercised by handleIdeRequest.
 */
interface FakeMcpClient {
  listTools: () => Promise<{ tools: unknown[] }>;
  callTool: (...args: unknown[]) => Promise<unknown>;
  listResources: () => Promise<{ resources: unknown[] }>;
  readResource: (...args: unknown[]) => Promise<unknown>;
  listResourceTemplates: () => Promise<{ resourceTemplates: unknown[] }>;
  close: () => Promise<void>;
}

function createFakeMcpClient(overrides: Partial<FakeMcpClient> = {}): FakeMcpClient {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [] }),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    close: async () => {},
    ...overrides,
  };
}

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

function sendRequest(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<DaemonResponse> {
  return sendSocketRequest(socketPath, method, params);
}

class PersistentSocketClient {
  private readonly socket = new Socket();
  private buffer = "";
  private readonly responses = new Map<string, DaemonResponse>();
  private readonly waiters = new Map<string, (response: DaemonResponse) => void>();

  async connect(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.connect(socketPath, resolve);
      this.socket.on("error", reject);
      this.socket.on("data", data => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          const response = JSON.parse(line) as DaemonResponse;
          const waiter = this.waiters.get(response.id);
          if (waiter) {
            this.waiters.delete(response.id);
            waiter(response);
          } else {
            this.responses.set(response.id, response);
          }
        }
      });
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<DaemonResponse> {
    const id = randomUUID();
    this.socket.write(JSON.stringify({ id, type: "mcp_request", method, params }) + "\n");
    const buffered = this.responses.get(id);
    if (buffered) {
      this.responses.delete(id);
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => {
      // Bounded: an unanswered request must fail fast with a diagnostic, not
      // pend until the suite's wall-clock watchdog (macos hang class, #5391).
      const deadline = defaultTimer.setTimeout(() => {
        this.waiters.delete(id);
        this.socket.destroy();
        reject(new Error(`No response to ${method} within ${SOCKET_REQUEST_DEADLINE_MS}ms — bounded socket-test deadline hit`));
      }, SOCKET_REQUEST_DEADLINE_MS);
      this.waiters.set(id, response => {
        defaultTimer.clearTimeout(deadline);
        resolve(response);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

describe("UnixSocketServer MCP session reconnect", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `mcp-rc-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("retries with a fresh client when MCP throws 'Session not found'", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        listTools: async () => {
          if (clientIndex === 1) {
            throw new Error("Session not found");
          }
          return { tools: [{ name: "observe" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/list");

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("observe");
  });

  test("resets cached client before reconnecting so getMcpClient creates a fresh one", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      ++clientsCreated;
      return createFakeMcpClient({
        listTools: async () => {
          if (clientsCreated === 1) {
            throw new Error("Session not found: MCP session expired");
          }
          return { tools: [] };
        },
      });
    };

    await sendRequest(socketPath, "tools/list");

    // After reconnect, the per-key client cache should hold the fresh client.
    expect((server as any).mcpClients.size).toBe(1);
    expect(clientsCreated).toBe(2);
  });

  test("does not retry on non-session errors and returns failure", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      ++clientsCreated;
      return createFakeMcpClient({
        listTools: async () => {
          throw new Error("Connection refused");
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/list");

    expect(response.success).toBe(false);
    expect(response.error).toContain("Connection refused");
    // Only one client created — no retry
    expect(clientsCreated).toBe(1);
  });

  test("subsequent requests reuse the reconnected client without creating another", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      ++clientsCreated;
      const isFailing = clientsCreated === 1;
      return createFakeMcpClient({
        listTools: async () => {
          if (isFailing) {throw new Error("Session not found");}
          return { tools: [] };
        },
      });
    };

    // First request triggers reconnect (2 clients)
    const first = await sendRequest(socketPath, "tools/list");
    expect(first.success).toBe(true);
    expect(clientsCreated).toBe(2);

    // Second request reuses the cached client (still 2 clients)
    const second = await sendRequest(socketPath, "tools/list");
    expect(second.success).toBe(true);
    expect(clientsCreated).toBe(2);
  });

  test("replays a bound session when tools/list reconnects its MCP client", async () => {
    const clientBindings: Array<string | undefined> = [];
    server.mcpClientFactory = async boundSessionUuid => {
      clientBindings.push(boundSessionUuid);
      const isFirstClient = clientBindings.length === 1;
      return createFakeMcpClient({
        listTools: async () => {
          if (isFirstClient) {
            throw new Error("Session not found");
          }
          return { tools: [{ name: boundSessionUuid ?? "unbound" }] };
        },
      });
    };

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      const boundCall = await client.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      });
      const list = await client.request("tools/list", {});

      expect(boundCall.success).toBe(true);
      expect(clientBindings).toEqual(["session-a", "session-a"]);
      expect(list.result).toEqual({ tools: [{ name: "session-a" }] });
    } finally {
      client.close();
    }
  });

  test("seeds a session-scoped client for a reconnected tools/list carrying {sessionUuid}", async () => {
    // After a reconnect the proxy re-sends `{sessionUuid}` on tools/list
    // (daemonMcpProxy.listTools). A FRESH socket has no bound route, so the route
    // must honor the request's session and build a SESSION-SEEDED client —
    // otherwise the shared UNSEEDED client returns the full, unfiltered list
    // instead of the session-scoped one (issue #4610).
    const clientBindings: Array<string | undefined> = [];
    server.mcpClientFactory = async boundSessionUuid => {
      clientBindings.push(boundSessionUuid);
      return createFakeMcpClient({
        listTools: async () => ({ tools: [{ name: boundSessionUuid ?? "unbound" }] }),
      });
    };

    const response = await sendRequest(socketPath, "tools/list", { sessionUuid: "session-a" });

    expect(response.success).toBe(true);
    // The loopback transport was seeded with the requested session, not left unbound.
    expect(clientBindings).toEqual(["session-a"]);
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toEqual([{ name: "session-a" }]);
  });

  test("closes idle per-key MCP clients after the idle timeout", async () => {
    let closeCalls = 0;

    server.mcpClientFactory = async () => createFakeMcpClient({
      listTools: async () => ({ tools: [] }),
      close: async () => {
        closeCalls++;
      },
    });

    const response = await sendRequest(socketPath, "tools/list");

    expect(response.success).toBe(true);
    expect((server as any).mcpClients.size).toBe(1);

    fakeTimer.advanceTime(5 * 60 * 1000);
    await Promise.resolve();

    expect(closeCalls).toBe(1);
    expect((server as any).mcpClients.size).toBe(0);
  });
});
