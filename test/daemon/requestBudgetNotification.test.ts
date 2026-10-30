import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fakeBindLock, unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import { resolveMcpRequestTimeoutMs } from "../../src/daemon/mcpRequestTimeout";
import { REQUEST_BUDGET_NOTIFICATION_METHOD, type DaemonRequest } from "../../src/daemon/types";
import { FakeSocket } from "../fakes/FakeNetServer";
import { DaemonClient, DAEMON_RESPONSE_GRACE_MS } from "../../src/daemon/client/client";
import { McpTimeoutError } from "../../src/daemon/wire/McpTimeoutError";
import { createRequestContext } from "../../src/daemon/requestContext";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { ISOLATED_DAEMON_RECOVERY } from "../helpers/isolatedDaemonRecovery";
import { daemonRequestFrameSchema } from "../helpers/wireMessageSchemas";
import { FakeTimer } from "../fakes/FakeTimer";
import { daemonNotificationFrameSchema } from "../helpers/wireMessageSchemas";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";

/**
 * The client sizes its backstop from its own environment; the daemon resolves per-tool floors from
 * its own (#13797). The daemon announces any difference to opted-in clients so their backstops
 * adopt its effective budget, whether larger or smaller.
 */

const SENT_MS = 1_000;

let server: UnixSocketServerHarness;
const sockets: FakeSocket[] = [];

function createServer(env: NodeJS.ProcessEnv = {}) {
  const server = new UnixSocketServerHarness(
    "unused",
    createFakeDaemonState(new Map()),
    new FakeTimer(),
    undefined,
    { mcpDispatcher: unreachableMcpDispatcher, requestTimeoutEnv: env },
    new FakeIdGenerator(),
    { bindLock: fakeBindLock },
  );
  server.allowRequests();
  return server;
}

beforeEach(() => {
  server = createServer();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
});

function installApp(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    id: "req-1",
    type: "mcp_request",
    method: "tools/call",
    params: { name: "installApp", arguments: {} },
    timeoutMs: SENT_MS,
    ...overrides,
  };
}

async function send(request: DaemonRequest): Promise<FakeSocket> {
  const socket = new FakeSocket();
  sockets.push(socket);
  server.connect(socket);
  socket.send(request);
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all([...server.state.activeRequestHandlers]);
  return socket;
}

const budgetNotifications = (socket: FakeSocket) =>
  socket.responses.flatMap((frame) => {
    const parsed = daemonNotificationFrameSchema.safeParse(frame);
    return parsed.success && parsed.data.method === REQUEST_BUDGET_NOTIFICATION_METHOD
      ? [parsed.data]
      : [];
  });

describe("daemon request budget notification (#13797)", () => {
  test("an opted-in client is told the larger budget the daemon resolved", async () => {
    const request = installApp({ acceptsRequestBudget: true });
    const resolved = resolveMcpRequestTimeoutMs(request);
    expect(resolved).toBeGreaterThan(SENT_MS);

    const socket = await send(request);

    expect(budgetNotifications(socket)).toEqual([
      {
        type: "daemon_notification",
        method: REQUEST_BUDGET_NOTIFICATION_METHOD,
        requestId: "req-1",
        timeoutMs: resolved,
      },
    ]);
  });

  test("a client that did not opt in never receives the notification", async () => {
    const socket = await send(installApp());

    expect(budgetNotifications(socket)).toEqual([]);
  });

  test("no notification when the client sent exactly the resolved budget", async () => {
    const resolved = resolveMcpRequestTimeoutMs(installApp());
    const socket = await send(installApp({ acceptsRequestBudget: true, timeoutMs: resolved }));

    expect(budgetNotifications(socket)).toEqual([]);
  });

  test("a control frame is never announced even when it opts in", async () => {
    const socket = await send({
      id: "ctl-1",
      type: "daemon_request",
      method: "daemon/cancelRequest",
      params: { requestId: "other" },
      timeoutMs: 1,
      acceptsRequestBudget: true,
    });

    expect(budgetNotifications(socket)).toEqual([]);
  });
});

/** Version skew uses the real client's serialized frame; only legacy fields are removed. */
function captureClient(env: NodeJS.ProcessEnv = {}) {
  const timer = new FakeTimer();
  const socket = new FakeSocket();
  const client = new DaemonClient("/fake/socket", 120_000, timer, ISOLATED_DAEMON_RECOVERY, {
    clientIdentity: null,
    env,
    idGenerator: new FakeIdGenerator(),
  });
  client.testHooks.attachSocket(socket);
  const outcome = client.callTool("openLink", {}).catch((error: unknown) => error);
  const request = daemonRequestFrameSchema.parse(socket.getWrittenMessages()[0]);
  return { timer, socket, client, request, outcome };
}

async function relayBudget(client: DaemonClient, request: DaemonRequest) {
  const socket = await send(request);
  for (const notice of budgetNotifications(socket)) {
    client.testHooks.simulateIncomingData(Buffer.from(JSON.stringify(notice) + "\n"));
  }
  return socket;
}

describe("daemon-owned budgets across client versions (#13797)", () => {
  test("new client explicit 45000 reaches the daemon context and matches its backstop", async () => {
    const h = captureClient({ AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS: "45000" });
    let contextBudget = 0;
    server.requestHandler = async (sessionId, _socket, request, { receivedAtMs }) => {
      contextBudget = createRequestContext(request, sessionId, receivedAtMs).totalTimeoutMs;
      return undefined;
    };
    try {
      const socket = await relayBudget(h.client, h.request);
      expect(contextBudget).toBe(45_000);
      expect(budgetNotifications(socket)).toEqual([]);
      expect(h.timer.getPendingTimeouts()).toEqual([45_000 + DAEMON_RESPONSE_GRACE_MS]);
      h.timer.advanceTime(45_000 + DAEMON_RESPONSE_GRACE_MS);
      expect(await h.outcome).toBeInstanceOf(McpTimeoutError);
      expect(h.socket.getWrittenMessages(daemonRequestFrameSchema)[1]?.method).toBe(
        "daemon/cancelRequest",
      );
    } finally {
      await h.client.close();
      await h.outcome;
    }
  });

  test.each([true, false])(
    "old client without requested metadata, opted-in=%s, daemon lower wins",
    async (optedIn) => {
      server = createServer({ AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS: "45000" });
      const h = captureClient();
      delete h.request.requestedTimeoutMs;
      if (!optedIn) {
        delete h.request.acceptsRequestBudget;
      }
      let contextBudget = 0;
      server.requestHandler = async (sessionId, _socket, request, { receivedAtMs }) => {
        contextBudget = createRequestContext(request, sessionId, receivedAtMs).totalTimeoutMs;
        return undefined;
      };
      try {
        expect(h.request.timeoutMs).toBe(120_000);
        const socket = await relayBudget(h.client, h.request);
        expect(contextBudget).toBe(45_000);
        expect(budgetNotifications(socket)).toHaveLength(optedIn ? 1 : 0);
        expect(h.timer.getPendingTimeouts()).toEqual([
          (optedIn ? 45_000 : 120_000) + DAEMON_RESPONSE_GRACE_MS,
        ]);
      } finally {
        await h.client.close();
        await h.outcome;
      }
    },
  );

  test("daemon-only raised override is announced and adopted", async () => {
    server = createServer({ AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS: "180000" });
    const h = captureClient();
    server.requestHandler = async () => undefined;
    try {
      const socket = await relayBudget(h.client, h.request);
      expect(budgetNotifications(socket)[0]?.timeoutMs).toBe(180_000);
      expect(h.timer.getPendingTimeouts()).toEqual([180_000 + DAEMON_RESPONSE_GRACE_MS]);
    } finally {
      await h.client.close();
      await h.outcome;
    }
  });

  test("new client with an old daemon keeps its sent budget when no notice arrives", async () => {
    const h = captureClient({ AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS: "45000" });
    try {
      expect(h.request.requestedTimeoutMs).toBe(45_000);
      h.timer.advanceTime(h.request.timeoutMs! + DAEMON_RESPONSE_GRACE_MS - 1);
      expect(h.client.testHooks.hasPendingRequest(h.request.id)).toBe(true);
      h.timer.advanceTime(1);
      expect(await h.outcome).toBeInstanceOf(McpTimeoutError);
    } finally {
      await h.client.close();
      await h.outcome;
    }
  });
});
