import { afterEach, describe, expect, test } from "bun:test";
import { DAEMON_BOUND_SESSION_PARAM } from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

interface ForwardRoute {
  clientKey: string;
  executionKey: string;
  sessionUuid?: string;
}

/** The socket server's route bookkeeping, driven as its request loop drives it. */
interface RouteInternals {
  recordBoundMcpClientKey(
    request: DaemonRequest,
    socketSessionId: string,
    route: ForwardRoute,
    sessionWasActiveBeforeForward: boolean,
    response: unknown,
  ): void;
  boundMcpClientKeysBySocketSession: Map<string, { sessionUuid?: string }>;
}

const SOCKET = "socket-1";

afterEach(() => DaemonState.getInstance().reset());

function newServer(): RouteInternals {
  const server = new UnixSocketServer(
    "/fake/one-call-session-route.sock",
    "http://localhost:0/mcp",
    DaemonState.getInstance(),
    new FakeTimer(),
  );
  return server as unknown as RouteInternals;
}

/** Forward one `tapOn` that routed to `sessionUuid`, carrying `boundSessionUuid` when given. */
function forward(server: RouteInternals, sessionUuid: string, boundSessionUuid?: string): void {
  const request: DaemonRequest = {
    id: "call",
    type: "mcp_request",
    method: "tools/call",
    params: {
      name: "tapOn",
      arguments: {
        sessionUuid,
        ...(boundSessionUuid ? { [DAEMON_BOUND_SESSION_PARAM]: boundSessionUuid } : {}),
      },
    },
  };
  const route = {
    clientKey: `socket:${SOCKET}:session:${sessionUuid}`,
    executionKey: `session:${sessionUuid}`,
    sessionUuid,
  };
  server.recordBoundMcpClientKey(request, SOCKET, route, false, { content: [] });
}

function routedSession(server: RouteInternals): string | undefined {
  return server.boundMcpClientKeysBySocketSession.get(SOCKET)?.sessionUuid;
}

describe("the daemon socket's route follows the connection's default, not a named session (#11347)", () => {
  test("a call under the connection's own binding sets the route", () => {
    const server = newServer();

    forward(server, "session-a", "session-a");

    expect(routedSession(server)).toBe("session-a");
  });

  test("a call naming another session beside the binding leaves the route alone", () => {
    const server = newServer();
    forward(server, "session-a", "session-a");

    forward(server, "session-b", "session-a");

    expect(routedSession(server)).toBe("session-a");
  });

  test("a call naming another session beside the binding does not establish a route either", () => {
    const server = newServer();

    forward(server, "session-b", "session-a");

    expect(routedSession(server)).toBeUndefined();
  });

  test("the route moves when the connection's binding moves", () => {
    const server = newServer();
    forward(server, "session-a", "session-a");

    forward(server, "session-b", "session-b");

    expect(routedSession(server)).toBe("session-b");
  });

  test("a client that declares no binding still routes by the session it names", () => {
    const server = newServer();

    forward(server, "session-a");
    forward(server, "session-b");

    expect(routedSession(server)).toBe("session-b");
  });
});
