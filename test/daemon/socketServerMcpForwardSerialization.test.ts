import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";

interface FakeMcpClient {
  callTool: (...args: unknown[]) => Promise<unknown>;
  listTools: () => Promise<{ tools: unknown[] }>;
  listResources: () => Promise<{ resources: unknown[] }>;
  readResource: (...args: unknown[]) => Promise<unknown>;
  listResourceTemplates: () => Promise<{ resourceTemplates: unknown[] }>;
  close: () => Promise<void>;
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

function sendRequest(socketPath: string, request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    let buffer = "";

    client.connect(socketPath, () => {
      client.write(JSON.stringify(request) + "\n");
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

function sendToolsCallWithArgs(
  socketPath: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<DaemonResponse> {
  return sendRequest(socketPath, {
    id: randomUUID(),
    type: "mcp_request",
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
}

function sendToolsCallWithoutArgs(socketPath: string, toolName: string): Promise<DaemonResponse> {
  return sendRequest(socketPath, {
    id: randomUUID(),
    type: "mcp_request",
    method: "tools/call",
    params: { name: toolName },
  });
}

function sendTwoToolsCallsOnOneSocket(socketPath: string, toolName: string): Promise<DaemonResponse[]> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    const responses: DaemonResponse[] = [];
    let buffer = "";

    client.connect(socketPath, () => {
      for (let i = 0; i < 2; i++) {
        client.write(JSON.stringify({
          id: randomUUID(),
          type: "mcp_request",
          method: "tools/call",
          params: { name: toolName, arguments: {} },
        }) + "\n");
      }
    });

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        responses.push(JSON.parse(line) as DaemonResponse);
        if (responses.length === 2) {
          client.destroy();
          resolve(responses);
          return;
        }
      }
    });

    client.on("error", reject);
    client.on("close", () => {
      if (responses.length < 2) {
        reject(new Error(`Connection closed after ${responses.length} responses`));
      }
    });
  });
}

describe("UnixSocketServer MCP forward serialization", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `mcp-ser-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
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

  test("concurrent tools/call for the same device never overlaps inside callTool", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" }),
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("concurrent tools/call for different devices can overlap inside callTool", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" }),
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-2" }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(2);
    expect(inFlight).toBe(0);
  });

  test("concurrent implicit autolock tools/call from different sockets can overlap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const forwardedSessionIds: string[] = [];

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          const args = (request as { arguments: Record<string, unknown> }).arguments;
          forwardedSessionIds.push(String(args.__mcpSessionId));
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", {}),
      sendToolsCallWithArgs(socketPath, "observe", {}),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(2);
    expect(forwardedSessionIds).toHaveLength(2);
    expect(forwardedSessionIds[0]).not.toBe(forwardedSessionIds[1]);
  });

  test("forwards the Unix socket session as the implicit autolock key", async () => {
    const forwardedCalls: unknown[] = [];

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          forwardedCalls.push(request);
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "startDevice", { platform: "android" }),
      sendToolsCallWithArgs(socketPath, "startDevice", { platform: "android" }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(forwardedCalls).toHaveLength(2);

    const firstArgs = (forwardedCalls[0] as { arguments: Record<string, unknown> }).arguments;
    const secondArgs = (forwardedCalls[1] as { arguments: Record<string, unknown> }).arguments;
    expect(firstArgs.platform).toBe("android");
    expect(secondArgs.platform).toBe("android");
    expect(typeof firstArgs.__mcpSessionId).toBe("string");
    expect(typeof secondArgs.__mcpSessionId).toBe("string");
    expect(firstArgs.__mcpSessionId).not.toBe(secondArgs.__mcpSessionId);
  });

  test("uses a stable implicit autolock key for multiple calls on one Unix socket", async () => {
    const forwardedCalls: unknown[] = [];

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          forwardedCalls.push(request);
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const responses = await sendTwoToolsCallsOnOneSocket(socketPath, "observe");

    expect(responses.every(response => response.success)).toBe(true);
    expect(forwardedCalls).toHaveLength(2);
    const firstArgs = (forwardedCalls[0] as { arguments: Record<string, unknown> }).arguments;
    const secondArgs = (forwardedCalls[1] as { arguments: Record<string, unknown> }).arguments;
    expect(typeof firstArgs.__mcpSessionId).toBe("string");
    expect(secondArgs.__mcpSessionId).toBe(firstArgs.__mcpSessionId);
  });

  test("adds the Unix socket session autolock key when tool arguments are omitted", async () => {
    let forwardedCall: unknown;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          forwardedCall = request;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const response = await sendToolsCallWithoutArgs(socketPath, "observe");

    expect(response.success).toBe(true);
    expect(forwardedCall).toBeDefined();
    const args = (forwardedCall as { arguments: Record<string, unknown> }).arguments;
    expect(Object.keys(args)).toEqual(["__mcpSessionId"]);
    expect(typeof args.__mcpSessionId).toBe("string");
  });

  test("queued request fails fast when queue wait exceeds its timeout", async () => {
    let callCount = 0;
    let releaseBlockingRequest: () => void = () => {};
    const blockingPromise = new Promise<void>(r => { releaseBlockingRequest = r; });

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          callCount++;
          if (callCount === 1) {
            await blockingPromise;
          }
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    // First request: blocks in callTool until we release it
    const first = sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" });

    // Yield to the real event loop so the first request enters callTool
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(r => setImmediate(r));
    }

    // Second request: has a short timeout (500ms) that will expire in the queue
    const second = sendRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: { deviceId: "device-1" } },
      timeoutMs: 500,
    });

    // Yield to let socket data reach the server
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(r => setImmediate(r));
    }

    // Advance time past the second request's timeout while it's queued
    fakeTimer.advanceTime(600);

    // Release the blocking request
    releaseBlockingRequest();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toContain("waiting in queue");
  });
});
