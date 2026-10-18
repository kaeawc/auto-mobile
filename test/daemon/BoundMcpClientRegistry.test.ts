import { describe, expect, test } from "bun:test";
import { BoundMcpClientRegistry } from "../../src/daemon/socketServer/BoundMcpClientRegistry";
import type { McpForwardRoute } from "../../src/daemon/socketServer/McpForwardRouter";
import { DAEMON_BOUND_SESSION_PARAM } from "../../src/daemon/constants";
import type { DaemonRequest } from "../../src/daemon/types";

/** #11815: the bound-client registry extracted from UnixSocketServer, driven through a fake port. */
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const SOCKET = "socket-1";

const route: McpForwardRoute = { clientKey: "client", executionKey: "exec" };

interface Fakes {
  active: Set<string>;
  foreign: Set<string>;
  released: boolean;
  initialized: boolean;
}

function makeRegistry(overrides: Partial<Fakes> = {}) {
  const fakes: Fakes = {
    active: new Set([SESSION]),
    foreign: new Set(),
    released: false,
    initialized: true,
    ...overrides,
  };
  const registry = new BoundMcpClientRegistry({
    isReleasedBoundSession: () => fakes.released,
    isSessionOwnedByOtherConnection: (sessionUuid) => fakes.foreign.has(sessionUuid),
    hasActiveSession: (sessionUuid) => fakes.active.has(sessionUuid),
    isDaemonStateInitialized: () => fakes.initialized,
  });
  return { registry, fakes };
}

function toolCall(name: string, args: Record<string, unknown>): DaemonRequest {
  return { id: "1", method: "tools/call", params: { name, arguments: args } } as DaemonRequest;
}

describe("BoundMcpClientRegistry.record", () => {
  test("binds the socket to an explicit live session", () => {
    const { registry } = makeRegistry();
    registry.record(toolCall("observe", { sessionUuid: SESSION }), SOCKET, route, true, {});
    expect(registry.entries.get(SOCKET)).toEqual({
      clientKey: "client",
      executionKey: "exec",
      sessionUuid: SESSION,
      toolSelectionProfileUuid: undefined,
      requiresLiveDaemonSession: true,
    });
  });

  test("ignores non tools/call frames and device inventory tools", () => {
    const { registry } = makeRegistry();
    registry.record({ id: "1", method: "ping" } as DaemonRequest, SOCKET, route, true, {});
    registry.record(toolCall("listDevices", { sessionUuid: SESSION }), SOCKET, route, true, {});
    expect(registry.entries.size).toBe(0);
  });

  test("does not follow a session another connection owns", () => {
    const { registry } = makeRegistry({ foreign: new Set([SESSION]) });
    registry.record(toolCall("observe", { sessionUuid: SESSION }), SOCKET, route, true, {});
    expect(registry.entries.has(SOCKET)).toBe(false);
  });

  test("a one-call session beside the bound session leaves the default route alone", () => {
    const { registry } = makeRegistry({ active: new Set([SESSION, OTHER_SESSION]) });
    registry.record(
      toolCall("observe", { sessionUuid: OTHER_SESSION, [DAEMON_BOUND_SESSION_PARAM]: SESSION }),
      SOCKET,
      route,
      true,
      {},
    );
    expect(registry.entries.has(SOCKET)).toBe(false);
  });

  test("clears the binding once a previously active session is gone", () => {
    const { registry, fakes } = makeRegistry();
    registry.record(toolCall("observe", { sessionUuid: SESSION }), SOCKET, route, true, {});
    fakes.active.clear();
    registry.record(toolCall("observe", { sessionUuid: SESSION }), SOCKET, route, true, {});
    expect(registry.entries.has(SOCKET)).toBe(false);
  });

  test("a released bound session clears the binding", () => {
    const { registry, fakes } = makeRegistry();
    registry.record(toolCall("observe", { sessionUuid: SESSION }), SOCKET, route, true, {});
    fakes.released = true;
    registry.record(toolCall("observe", { sessionUuid: SESSION }), SOCKET, route, true, {});
    expect(registry.entries.has(SOCKET)).toBe(false);
  });

  test("a sessionless call that is not setToolEnabled records nothing", () => {
    const { registry } = makeRegistry();
    registry.record(toolCall("observe", {}), SOCKET, route, false, { content: [] });
    expect(registry.entries.size).toBe(0);
  });
});

describe("BoundMcpClientRegistry.routeFor", () => {
  function bound() {
    const made = makeRegistry();
    made.registry.record(toolCall("observe", { sessionUuid: SESSION }), SOCKET, route, true, {});
    return made;
  }

  test("returns the bound route while the session is live", () => {
    const { registry } = bound();
    expect(registry.routeFor(SOCKET)).toEqual({
      clientKey: "client",
      executionKey: "exec",
      sessionUuid: SESSION,
      toolSelectionProfileUuid: undefined,
    });
  });

  test("drops the binding when its session is no longer live", () => {
    const { registry, fakes } = bound();
    fakes.active.clear();
    expect(registry.routeFor(SOCKET)).toBeUndefined();
    expect(registry.entries.has(SOCKET)).toBe(false);
  });

  test("keeps the route for the session a recovery is replaying", () => {
    const { registry, fakes } = bound();
    fakes.active.clear();
    expect(registry.routeFor(SOCKET, SESSION)?.sessionUuid).toBe(SESSION);
  });

  test("keeps the route when daemon state is not initialized", () => {
    const { registry, fakes } = bound();
    fakes.initialized = false;
    expect(registry.routeFor(SOCKET)?.sessionUuid).toBe(SESSION);
  });

  test("an unknown socket has no route", () => {
    expect(makeRegistry().registry.routeFor("nobody")).toBeUndefined();
  });
});

describe("BoundMcpClientRegistry clearing", () => {
  function twoSockets() {
    const made = makeRegistry({ active: new Set([SESSION, OTHER_SESSION]) });
    made.registry.record(toolCall("observe", { sessionUuid: SESSION }), "a", route, true, {});
    made.registry.record(
      toolCall("observe", { sessionUuid: OTHER_SESSION }),
      "b",
      { clientKey: "client-b", executionKey: "exec-b" },
      true,
      {},
    );
    return made.registry;
  }

  test("clearForReleasedSession drops only that session's bindings", () => {
    const registry = twoSockets();
    registry.clearForReleasedSession(SESSION);
    expect([...registry.entries.keys()]).toEqual(["b"]);
  });

  test("isClientKeyBound reflects the live bindings", () => {
    const registry = twoSockets();
    expect(registry.isClientKeyBound("client-b")).toBe(true);
    registry.clear("b");
    expect(registry.isClientKeyBound("client-b")).toBe(false);
  });

  test("clearAll empties the registry", () => {
    const registry = twoSockets();
    registry.clearAll();
    expect(registry.entries.size).toBe(0);
  });
});
