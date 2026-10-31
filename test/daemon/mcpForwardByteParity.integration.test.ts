import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod/v4";
import {
  requestAcquisitionReceipt,
  runWithAcquisitionReceipt,
} from "../../src/daemon/acquisitionReceipt";
import {
  DAEMON_CANCEL_REQUEST_METHOD,
  DAEMON_RELEASED_SESSION_HEADER,
  DAEMON_SESSION_TOOL_BINDING_HEADER,
  DAEMON_TOOL_SELECTION_PROFILE_HEADER,
} from "../../src/daemon/wire/constants";
import { MCP_SESSION_KEY_HEADER } from "../../src/daemon/mcpSessionKey";
import {
  daemonLifecycleAllowed,
  runWithoutDaemonLifecycle,
} from "../../src/daemon/proxyLivenessRecovery";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { InProcessMcpDispatcher } from "../../src/daemon/inProcessMcpDispatcher";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import {
  currentForwardSessionKey,
  type McpClientFactory,
} from "../../src/daemon/socketServer/forwardSessionKey";
import { LoopbackMcpClient } from "../../src/daemon/socketServer/loopbackMcpClient";
import { StatelessMcpHttpEndpoint } from "../../src/daemon/statelessMcpHttpEndpoint";
import {
  buildMcpRequestContext,
  createStatelessMcpServer,
} from "../../src/daemon/statelessMcpServerFactory";
import type { DaemonRequest } from "../../src/daemon/types";
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import {
  selectedDisplayPin,
  runWithSelectedDisplayPin,
} from "../../src/features/observe/SessionDisplayContext";
import { ActionableError } from "../../src/models/ActionableError";
import { executionTracker } from "../../src/daemon/executionTracker";
import { SessionToolBindingStore } from "../../src/server/sessionToolBindingStore";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  getAbortSignal,
  getRequestContext,
  type RequestContext,
  runWithAbortSignal,
} from "../../src/utils/AbortContext";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import { fakeBindLock } from "../helpers/createTestUnixSocketServer";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { buildRefusalWireFixtures } from "../helpers/refusalWireFixtures";

/**
 * Byte parity of a control-socket forward through the HTTP loopback the daemon used before #11820
 * (an MCP client over the daemon's real stateless endpoint, which still serves the desktop app and
 * external clients) and through the in-process dispatcher that replaced it. Both paths build the
 * request's server with the same factory and serve the same socket frames; the raw response lines
 * each socket writes must be identical.
 * The context-leak probe checks that a handler reached in memory sees its own request's
 * AsyncLocalStorage stores, not the stores of the socket chain that forwarded it.
 */
type ForwardPath = "http" | "in-process" | "in-process-unrooted";

const RESULT_TOOL = "parityResult";
const ACTIONABLE_TOOL = "parityActionableError";
const PLAIN_ERROR_TOOL = "parityPlainError";
const PROGRESS_TOOL = "parityProgress";
const HOLD_TOOL = "parityHold";
const REFUSAL_TOOL = "parityRefusal";
const PROBE_TOOL = "parityContextProbe";
const IO_DEADLINE_MS = 5_000;

const refusals = new Map(buildRefusalWireFixtures().map((fixture) => [fixture.code, fixture]));
// The refusal parity test sends one call per code, in order, on each of two forward paths, and
// each call builds its own MCP server (#14695). Size its timeout from the table so a loaded
// safe-tier run, or a new refusal code, cannot push it past a fixed 20 s.
const REFUSAL_CALL_BUDGET_MS = 500;
const REFUSAL_PARITY_TIMEOUT_MS = Math.max(20_000, refusals.size * 2 * REFUSAL_CALL_BUDGET_MS);

function fakeDaemonState(): DaemonStateAccess {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      hasSession: () => false,
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
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
}

/**
 * The forward client the daemon used before #11820: an MCP client over streamable HTTP to the
 * daemon's own endpoint, sending the forward's context and session key as headers. Kept here as
 * the reference the in-process path must match byte for byte.
 */
function httpForwardClientFactory(url: string): McpClientFactory {
  return async (boundSessionUuid, toolSelectionProfileUuid, releasedSessionUuid) => {
    const sessionKey = currentForwardSessionKey();
    const headers: Record<string, string> = {
      ...(sessionKey ? { [MCP_SESSION_KEY_HEADER]: sessionKey } : {}),
      ...(boundSessionUuid ? { [DAEMON_SESSION_TOOL_BINDING_HEADER]: boundSessionUuid } : {}),
      ...(releasedSessionUuid ? { [DAEMON_RELEASED_SESSION_HEADER]: releasedSessionUuid } : {}),
      ...(toolSelectionProfileUuid
        ? { [DAEMON_TOOL_SELECTION_PROFILE_HEADER]: toolSelectionProfileUuid }
        : {}),
    };
    const client = new LoopbackMcpClient(
      { name: "auto-mobile-daemon-client", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers },
        reconnectionOptions: {
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 30_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 0,
        },
      }),
    );
    return client;
  };
}

/** What a handler sees of the async context it runs in. */
interface ContextSnapshot {
  readonly abortSignalIsRequestOwn: boolean;
  readonly requestContextIsSocketSide: boolean;
  readonly callerMcpSessionId: string | undefined;
  readonly labelSessionUuids: readonly string[] | undefined;
  readonly acquisitionReceipt: boolean;
  readonly daemonLifecycleAllowed: boolean;
  readonly displayPin: string | undefined;
  readonly forwardSessionKey: string | undefined;
}

const SOCKET_SIDE_REQUEST: RequestContext = {
  getDeadlineMs: () => 1,
  textState: { dispatched: () => () => {} },
};

/** Run `start` inside a set of socket-side stores a handler must never inherit. */
async function withSocketSideStores(start: () => Promise<void>): Promise<void> {
  const socketSideSignal = new AbortController().signal;
  await runWithAbortSignal(
    socketSideSignal,
    () =>
      runWithToolSelectionContext(
        { callerMcpSessionId: "socket-side-caller", labelSessionUuids: ["socket-side-label"] },
        () =>
          runWithoutDaemonLifecycle(() =>
            runWithAcquisitionReceipt({}, () =>
              runWithSelectedDisplayPin({ pin: "socket-side-pin", inventory: undefined }, start),
            ),
          ),
      ),
    SOCKET_SIDE_REQUEST,
  );
}

interface Harness {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * One socket server over one forward path. The id generators restart for every harness, so
 * socket session ids, live-deadline keys and request scopes line up across paths.
 */
async function startHarness(
  path: ForwardPath,
  options: { socketSideStores?: boolean } = {},
): Promise<Harness> {
  const store = new SessionToolBindingStore();
  const scopeIds = new CountingIdGenerator("scope");
  const serverBase = { sessionToolBindingStore: store };
  const cancelScopeExecutions = (
    scope: string,
    reason: Parameters<typeof executionTracker.cancelSessionExecutions>[1],
  ) => executionTracker.cancelSessionExecutions(scope, reason);
  let httpServer: Server | undefined;
  let endpointUrl = "http://127.0.0.1:1/unused";
  // Built where the daemon builds it: at start, outside any request's stores.
  const dispatcher = new InProcessMcpDispatcher({
    idGenerator: scopeIds,
    createServer: (context, scope) => createStatelessMcpServer(serverBase, context, scope),
    cancelScopeExecutions,
    forgetScopeBindings: (scope) => store.forget(scope),
    closeReason: () => "streamable_http_onclose",
    ...(path === "in-process-unrooted" ? { serverScope: { run: (fn) => fn() } } : {}),
  });
  if (path === "http") {
    const endpoint = new StatelessMcpHttpEndpoint<
      IncomingMessage,
      ServerResponse,
      NodeStreamableHTTPServerTransport
    >({
      timer: new FakeTimer(),
      idGenerator: scopeIds,
      keepaliveIntervalMs: 30_000,
      createTransport: () =>
        new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined }),
      createServer: (req, scope) =>
        createStatelessMcpServer(
          serverBase,
          buildMcpRequestContext({ headers: req.headers }),
          scope,
        ),
      cancelScopeExecutions,
      forgetScopeBindings: (scope) => store.forget(scope),
      closeReason: () => "streamable_http_onclose",
    });
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        void endpoint.handle(req, res, text ? JSON.parse(text) : undefined, () => {});
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    httpServer = server;
    endpointUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auto-mobile/streamable`;
  }
  const socketPath = join(tmpdir(), `mcp-parity-${randomUUID().slice(0, 8)}.sock`);
  const socketServer = new UnixSocketServer(
    socketPath,
    fakeDaemonState(),
    defaultTimer,
    null,
    { mcpDispatcher: dispatcher },
    new CountingIdGenerator("socket"),
    { bindLock: fakeBindLock },
  );
  if (path === "http") {
    socketServer.mcpClientFactory = httpForwardClientFactory(endpointUrl);
  }
  const start = () => socketServer.start();
  await (options.socketSideStores ? withSocketSideStores(start) : start());
  return {
    socketPath,
    close: async () => {
      await socketServer.close();
      if (httpServer) {
        const server = httpServer;
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
      }
      if (existsSync(socketPath)) {
        await unlink(socketPath);
      }
    },
  };
}

/** One socket connection that records every raw line the daemon writes to it. */
class Conversation {
  readonly lines: string[] = [];
  private buffer = "";
  private waiters: Array<() => void> = [];

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const parts = this.buffer.split("\n");
      this.buffer = parts.pop() ?? "";
      this.lines.push(...parts.filter((line) => line.trim().length > 0));
      const waiters = this.waiters;
      this.waiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    });
  }

  static async open(socketPath: string): Promise<Conversation> {
    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.connect(socketPath, resolve);
    });
    return new Conversation(socket);
  }

  send(request: DaemonRequest): void {
    this.socket.write(`${JSON.stringify(request)}\n`);
  }

  /** The raw line answering `id` (its terminal response, never a progress notification). */
  async answer(id: string): Promise<string> {
    const deadline = Date.now() + IO_DEADLINE_MS;
    for (;;) {
      const line = this.lines.find((candidate) => {
        const frame = JSON.parse(candidate) as { id?: string; type?: string };
        return frame.id === id && frame.type !== "daemon_notification";
      });
      if (line !== undefined) {
        return line;
      }
      if (Date.now() > deadline) {
        throw new Error(`No answer to ${id}; lines so far: ${this.lines.join("\n")}`);
      }
      await new Promise<void>((resolve) => {
        const handle = defaultTimer.setTimeout(resolve, 20);
        this.waiters.push(() => {
          defaultTimer.clearTimeout(handle);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): DaemonRequest {
  return { id, type: "mcp_request", method: "tools/call", params: { name, arguments: args } };
}

/** Run `script` on a fresh harness per path and return each path's raw lines. */
async function linesPerPath(
  paths: readonly ForwardPath[],
  script: (conversation: Conversation) => Promise<void>,
  options: { socketSideStores?: boolean } = {},
): Promise<Map<ForwardPath, string[]>> {
  const result = new Map<ForwardPath, string[]>();
  for (const path of paths) {
    const harness = await startHarness(path, options);
    const conversation = await Conversation.open(harness.socketPath);
    try {
      await script(conversation);
      result.set(path, [...conversation.lines]);
    } finally {
      conversation.close();
      await harness.close();
    }
  }
  return result;
}

async function expectByteParity(script: (conversation: Conversation) => Promise<void>) {
  const lines = await linesPerPath(["http", "in-process"], script);
  expect(lines.get("in-process")).toEqual(lines.get("http")!);
  return lines.get("http")!;
}

describe("control-socket forward byte parity: HTTP loopback vs in process (#11820)", () => {
  let restoreFixture: () => void;
  let holdStarted: (() => void) | undefined;
  let holdSignals: AbortSignal[] = [];
  let probes: ContextSnapshot[] = [];

  beforeAll(() => {
    restoreFixture = installHermeticServerFixture();
    ToolRegistry.register(RESULT_TOOL, "parity result", z.object({}), async () => ({
      content: [{ type: "text", text: `ok \u2713 ${String.fromCharCode(0x2028)} "quoted"` }],
      structuredContent: { dropped: undefined, kept: [1, null, "x"], nested: { n: 1.5 } },
    }));
    ToolRegistry.register(ACTIONABLE_TOOL, "parity actionable", z.object({}), async () => {
      throw new ActionableError("parity actionable failure");
    });
    ToolRegistry.register(PLAIN_ERROR_TOOL, "parity plain", z.object({}), async () => {
      throw new Error("parity plain failure");
    });
    ToolRegistry.register(PROGRESS_TOOL, "parity progress", z.object({}), {
      handler: async (_args, progress) => {
        await progress?.(1, 2, "half way");
        await progress?.(2, 2);
        return { content: [{ type: "text", text: "progressed" }] };
      },
      supportsProgress: true,
    });
    ToolRegistry.register(
      HOLD_TOOL,
      "parity hold",
      z.object({}),
      async (_args, _progress, signal) => {
        if (signal) {
          holdSignals.push(signal);
        }
        holdStarted?.();
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { content: [{ type: "text", text: "hold ended" }] };
      },
    );
    ToolRegistry.register(
      REFUSAL_TOOL,
      "parity refusal",
      z.object({ code: z.string() }),
      async (args: { code: string }) => refusals.get(args.code)!.result,
    );
    ToolRegistry.register(
      PROBE_TOOL,
      "parity probe",
      z.object({}),
      async (_args, _progress, signal) => {
        const selection = getToolSelectionContext();
        probes.push({
          abortSignalIsRequestOwn: getAbortSignal() === signal,
          requestContextIsSocketSide: getRequestContext() === SOCKET_SIDE_REQUEST,
          callerMcpSessionId: selection?.callerMcpSessionId,
          labelSessionUuids: selection?.labelSessionUuids,
          acquisitionReceipt: requestAcquisitionReceipt() !== undefined,
          daemonLifecycleAllowed: daemonLifecycleAllowed(),
          displayPin: selectedDisplayPin(),
          forwardSessionKey: currentForwardSessionKey(),
        });
        return { content: [{ type: "text", text: "probed" }] };
      },
    );
  });

  afterAll(() => {
    for (const name of [
      RESULT_TOOL,
      ACTIONABLE_TOOL,
      PLAIN_ERROR_TOOL,
      PROGRESS_TOOL,
      HOLD_TOOL,
      REFUSAL_TOOL,
      PROBE_TOOL,
    ]) {
      ToolRegistry.unregister(name);
    }
    restoreFixture();
  });

  afterEach(() => {
    holdStarted = undefined;
    holdSignals = [];
    probes = [];
  });

  test("a tool result, with undefined fields and JSON-hostile text", async () => {
    const [line] = await expectByteParity(async (conversation) => {
      conversation.send(toolCall("result", RESULT_TOOL));
      await conversation.answer("result");
    });
    expect(line).not.toContain("dropped");
    expect(JSON.parse(line).success).toBe(true);
  });

  test("tool failures: actionable, plain, unknown tool and invalid arguments", async () => {
    const lines = await expectByteParity(async (conversation) => {
      conversation.send(toolCall("actionable", ACTIONABLE_TOOL));
      await conversation.answer("actionable");
      conversation.send(toolCall("plain", PLAIN_ERROR_TOOL));
      await conversation.answer("plain");
      conversation.send(toolCall("unknown", "parityNoSuchTool"));
      await conversation.answer("unknown");
      conversation.send(toolCall("invalid", REFUSAL_TOOL, { code: 7 }));
      await conversation.answer("invalid");
    });
    expect(lines).toHaveLength(4);
  });

  test("tools/list, resources/list and an unknown resources/read", async () => {
    const lines = await expectByteParity(async (conversation) => {
      conversation.send({ id: "tools", type: "mcp_request", method: "tools/list", params: {} });
      await conversation.answer("tools");
      conversation.send({
        id: "resources",
        type: "mcp_request",
        method: "resources/list",
        params: {},
      });
      await conversation.answer("resources");
      conversation.send({
        id: "read",
        type: "mcp_request",
        method: "resources/read",
        params: { uri: "automobile:parity/no-such-resource" },
      });
      await conversation.answer("read");
    });
    expect(lines.join("\n")).toContain(RESULT_TOOL);
  });

  test("progress notifications and the result they precede", async () => {
    const lines = await expectByteParity(async (conversation) => {
      conversation.send({ ...toolCall("progress", PROGRESS_TOOL), progressToken: "parity-token" });
      await conversation.answer("progress");
    });
    expect(lines.filter((line) => line.includes("parity-token")).length).toBe(2);
  });

  test("a socket cancel frame aborts the handler and answers identically", async () => {
    const lines = await expectByteParity(async (conversation) => {
      const started = new Promise<void>((resolve) => {
        holdStarted = resolve;
      });
      conversation.send(toolCall("hold", HOLD_TOOL));
      await started;
      conversation.send({
        id: "cancel",
        type: "daemon_request",
        method: DAEMON_CANCEL_REQUEST_METHOD,
        params: { requestId: "hold" },
      });
      await conversation.answer("cancel");
      await conversation.answer("hold");
    });
    expect(holdSignals).toHaveLength(2);
    expect(holdSignals.every((signal) => signal.aborted)).toBe(true);
    expect(lines.map((line) => JSON.parse(line).id).sort()).toEqual(["cancel", "hold"]);
  });

  test(
    "every refusal fixture crosses both paths unchanged",
    async () => {
      const codes = [...refusals.keys()];
      const lines = await expectByteParity(async (conversation) => {
        for (const code of codes) {
          conversation.send(toolCall(`refusal:${code}`, REFUSAL_TOOL, { code }));
          await conversation.answer(`refusal:${code}`);
        }
      });
      expect(lines).toHaveLength(codes.length);
      for (const [index, code] of codes.entries()) {
        expect(JSON.parse(lines[index]).result).toEqual(refusals.get(code)!.result);
      }
    },
    REFUSAL_PARITY_TIMEOUT_MS,
  );

  test("context-leak probe: a handler sees its own request's stores, never the socket chain's", async () => {
    const run = async (path: ForwardPath) => {
      const before = probes.length;
      await linesPerPath(
        [path],
        async (conversation) => {
          conversation.send(toolCall("probe", PROBE_TOOL));
          await conversation.answer("probe");
        },
        { socketSideStores: true },
      );
      return probes.slice(before);
    };
    const [http] = await run("http");
    const [inProcess] = await run("in-process");
    const [unrooted] = await run("in-process-unrooted");

    expect(inProcess).toEqual(http);
    expect(http).toEqual({
      abortSignalIsRequestOwn: true,
      requestContextIsSocketSide: false,
      callerMcpSessionId: http.callerMcpSessionId,
      labelSessionUuids: http.labelSessionUuids,
      acquisitionReceipt: false,
      daemonLifecycleAllowed: true,
      displayPin: undefined,
      forwardSessionKey: undefined,
    });
    expect(http.callerMcpSessionId).not.toBe("socket-side-caller");
    expect(http.labelSessionUuids).not.toEqual(["socket-side-label"]);
    // The probe is sensitive: a pair entered from the forward's own context leaks.
    expect(unrooted).not.toEqual(http);
  });
});
