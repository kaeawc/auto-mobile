import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fakeBindLock, unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import { resolveMcpRequestTimeoutMs } from "../../src/daemon/mcpRequestTimeout";
import { REQUEST_BUDGET_NOTIFICATION_METHOD, type DaemonRequest } from "../../src/daemon/types";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { daemonNotificationFrameSchema } from "../helpers/wireMessageSchemas";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";

/**
 * The client sizes its backstop from its own environment; the daemon resolves per-tool floors from
 * its own (#13797). When the daemon will wait longer than the client sent, an opted-in client is told
 * so its backstop does not cancel a call still inside the daemon's budget.
 */

const SENT_MS = 1_000;

let server: UnixSocketServerHarness;
const sockets: FakeSocket[] = [];

beforeEach(() => {
  server = new UnixSocketServerHarness(
    "unused",
    createFakeDaemonState(new Map()),
    new FakeTimer(),
    undefined,
    { mcpDispatcher: unreachableMcpDispatcher },
    undefined,
    { bindLock: fakeBindLock },
  );
  server.allowRequests();
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

  test("no notification when the client already sent at least the resolved budget", async () => {
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
