import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { afterEach, describe, expect, test } from "bun:test";
import { DAEMON_BOUND_SESSION_PARAM } from "../../src/daemon/wire/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

const SOCKET = "socket-1";

afterEach(() => DaemonState.getInstance().reset());

function newServer(): UnixSocketServerHarness {
  return createHarnessServer(
    "/fake/one-call-session-route.sock",
    DaemonState.getInstance(),
    new FakeTimer(),
  );
}

/** Forward one `tapOn` that routed to `sessionUuid`, carrying `boundSessionUuid` when given. */
function forward(
  server: UnixSocketServerHarness,
  sessionUuid: string,
  boundSessionUuid?: string,
): void {
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
  server.recordForwardResult(request, SOCKET, route, false, { content: [] });
}

function routedSession(server: UnixSocketServerHarness): string | undefined {
  return server.boundSessionUuidFor(SOCKET);
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
