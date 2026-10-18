import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod/v4";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import {
  StatelessMcpHttpEndpoint,
  type StatelessMcpRequestScope,
} from "../../src/daemon/statelessMcpHttpEndpoint";
import type { DaemonResponse } from "../../src/daemon/types";
import { executionTracker } from "../../src/server/executionTracker";
import { createMcpServer } from "../../src/server/index";
import { MCP_SESSION_KEY_HEADER } from "../../src/server/mcpSessionKey";
import { SessionToolBindingStore } from "../../src/server/sessionToolBindingStore";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import { fakeBindLock } from "../helpers/createTestUnixSocketServer";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import {
  SOCKET_REQUEST_DEADLINE_MS,
  sendPersistentSocketRequest,
  sendRawSocketRequest,
  sendRequestOnPersistentSocket,
} from "./helpers/socketRequest";

/**
 * Slice C of #4678 against the REAL stateless endpoint (slice B): the socket server's pooled
 * loopback client talks to a `StatelessMcpHttpEndpoint` over real HTTP, and every request it
 * serves builds a real `createMcpServer` exactly as the daemon does. Only the device boundary
 * (hermetic fixture) and the daemon state are fake.
 */
const PROBE_TOOL = "statelessLoopbackProbe";
const HOLD_TOOL = "statelessLoopbackHold";

function fakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
    }),
  };
}

function toolText(response: DaemonResponse): string {
  const result = response.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? "";
}

interface LoopbackHarness {
  readonly url: string;
  /** The session-key header of every POST the endpoint served, in arrival order. */
  readonly headerKeys: Array<string | undefined>;
  /** The JSON-RPC method and HTTP status of every POST, in arrival order. */
  readonly posts: Array<{ method: string; status: () => number }>;
  readonly scopes: StatelessMcpRequestScope[];
  /** Swap in a fresh endpoint behind the same listener: a daemon MCP layer restart. */
  restartEndpoint(): void;
}

describe("socket loopback through the real stateless MCP endpoint", () => {
  let restoreFixture: () => void;
  let httpServer: Server;
  let harness: LoopbackHarness;
  let socketServer: UnixSocketServer;
  let socketPath: string;
  let holdStarted: ((signal: AbortSignal | undefined) => void) | undefined;
  let holdAborted: (() => void) | undefined;

  beforeAll(() => {
    restoreFixture = installHermeticServerFixture();
    ToolRegistry.register(PROBE_TOOL, "test probe", z.object({}), async () => ({
      content: [{ type: "text", text: "probe ok" }],
    }));
    ToolRegistry.register(
      HOLD_TOOL,
      "test hold",
      z.object({}),
      async (_args, _progress, signal) => {
        holdStarted?.(signal);
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        holdAborted?.();
        return { content: [{ type: "text", text: "hold aborted" }] };
      },
    );
  });

  afterAll(() => {
    ToolRegistry.unregister(PROBE_TOOL);
    ToolRegistry.unregister(HOLD_TOOL);
    restoreFixture();
  });

  beforeEach(async () => {
    const headerKeys: Array<string | undefined> = [];
    const posts: LoopbackHarness["posts"] = [];
    const scopes: StatelessMcpRequestScope[] = [];
    const store = new SessionToolBindingStore();
    const makeEndpoint = () =>
      new StatelessMcpHttpEndpoint<
        IncomingMessage,
        ServerResponse,
        NodeStreamableHTTPServerTransport
      >({
        timer: new FakeTimer(),
        idGenerator: new CountingIdGenerator(`scope-${randomUUID()}`),
        keepaliveIntervalMs: 30_000,
        createTransport: () =>
          new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined }),
        createServer: (_req, scope) => {
          scopes.push(scope);
          return createMcpServer({
            sessionContext: { sessionId: scope.requestScopeId },
            daemonMode: true,
            requestMcpSessionId: scope.requestMcpSessionId,
            stateless: true,
            sessionToolBindingStore: store,
          });
        },
        cancelScopeExecutions: (scope, reason) =>
          executionTracker.cancelSessionExecutions(scope, reason),
        forgetScopeBindings: (scope) => store.forget(scope),
        closeReason: () => "streamable_http_onclose",
      });
    let endpoint = makeEndpoint();
    httpServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const header = req.headers[MCP_SESSION_KEY_HEADER];
        headerKeys.push(typeof header === "string" ? header : undefined);
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text ? (JSON.parse(text) as { method?: string }) : undefined;
        posts.push({ method: body?.method ?? req.method ?? "", status: () => res.statusCode });
        void endpoint.handle(req, res, text ? JSON.parse(text) : undefined, () => {});
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    harness = {
      url: `http://127.0.0.1:${port}/auto-mobile/streamable`,
      headerKeys,
      posts,
      scopes,
      restartEndpoint: () => {
        endpoint = makeEndpoint();
      },
    };
    socketPath = join(tmpdir(), `mcp-sl-${randomUUID().slice(0, 8)}.sock`);
    socketServer = new UnixSocketServer(
      socketPath,
      harness.url,
      fakeDaemonState(),
      defaultTimer,
      null,
      {},
      new CountingIdGenerator("socket"),
      { bindLock: fakeBindLock },
    );
    await socketServer.start();
  });

  afterEach(async () => {
    holdStarted = undefined;
    holdAborted = undefined;
    await socketServer.close();
    await new Promise<void>((resolve) => {
      httpServer.closeAllConnections();
      httpServer.close(() => resolve());
    });
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  const callTool = async (name: string): Promise<DaemonResponse> =>
    (
      await sendRawSocketRequest(socketPath, {
        id: randomUUID(),
        type: "mcp_request",
        method: "tools/call",
        params: { name, arguments: {} },
      })
    ).response;

  test("every forwarded POST carries the socket session id of the forward that sent it", async () => {
    const first = await callTool(PROBE_TOOL);
    const second = await callTool(PROBE_TOOL);

    expect(toolText(first)).toBe("probe ok");
    expect(toolText(second)).toBe("probe ok");
    // Every request a forward sends (the pooled client's initialize included) names the
    // socket connection that issued it, and each connection names its own.
    expect(harness.headerKeys.length).toBeGreaterThanOrEqual(2);
    expect(harness.headerKeys.every((key) => key?.startsWith("socket-"))).toBe(true);
    const keys = new Set(harness.scopes.map((scope) => scope.requestMcpSessionId));
    expect(keys.size).toBe(2);
    expect([...keys].every((key) => key?.startsWith("socket-"))).toBe(true);
  });

  test("a restarted endpoint serves the next forward with no 404 and no replay", async () => {
    const { response: before, socket } = await sendPersistentSocketRequest(
      socketPath,
      "tools/call",
      { name: PROBE_TOOL, arguments: {} },
    );
    try {
      expect(toolText(before)).toBe("probe ok");
      const postsBefore = harness.posts.length;

      harness.restartEndpoint();
      const after = await sendRequestOnPersistentSocket(socket, "tools/call", {
        name: PROBE_TOOL,
        arguments: {},
      });

      expect(after.success).toBe(true);
      expect(toolText(after)).toBe("probe ok");
      // The same pooled client sends exactly one tools/call POST: no re-initialize, no 404, no
      // replay, because there is no transport session for the restart to expire.
      const sent = harness.posts.slice(postsBefore);
      expect(sent.map((post) => post.method)).toEqual(["tools/call"]);
      expect(sent[0].status()).toBe(200);
    } finally {
      socket.destroy();
    }
  });

  test("a socket disconnect cancels the execution the endpoint keyed on its session id", async () => {
    const started = new Promise<AbortSignal | undefined>((resolve) => {
      holdStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      holdAborted = resolve;
    });
    const cancelSessionExecutions = executionTracker.cancelSessionExecutions.bind(executionTracker);
    let recordDisconnectCancel!: (cancel: { key: string; cancelled: number }) => void;
    const disconnectCancel = new Promise<{ key: string; cancelled: number }>((resolve) => {
      recordDisconnectCancel = resolve;
    });
    const spy = spyOn(executionTracker, "cancelSessionExecutions").mockImplementation(
      async (key, reason) => {
        const cancelled = await cancelSessionExecutions(key, reason);
        if (reason === "socket_disconnect") {
          recordDisconnectCancel({ key, cancelled });
        }
        return cancelled;
      },
    );
    const socket = new Socket();
    const deadline = defaultTimer.setTimeout(() => socket.destroy(), SOCKET_REQUEST_DEADLINE_MS);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.connect(socketPath, resolve);
      });
      socket.write(
        `${JSON.stringify({
          id: randomUUID(),
          type: "mcp_request",
          method: "tools/call",
          params: { name: HOLD_TOOL, arguments: {} },
        })}\n`,
      );
      const signal = await started;
      expect(signal).toBeDefined();
      const socketSessionId = harness.scopes.at(-1)?.requestMcpSessionId ?? "";
      expect(socketSessionId).toStartWith("socket-");
      expect(executionTracker.hasActiveSessionExecutions(socketSessionId)).toBe(true);

      socket.destroy();
      await aborted;

      expect(signal?.aborted).toBe(true);
      // The disconnect itself reached the execution through the socket session key, not
      // only the loopback POST closing.
      expect(await disconnectCancel).toEqual({ key: socketSessionId, cancelled: 1 });
    } finally {
      spy.mockRestore();
      defaultTimer.clearTimeout(deadline);
      socket.destroy();
    }
  });
});
