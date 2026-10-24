import { FakeMcpServer } from "../fakes/FakeMcpServer";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ListChangedBroadcaster } from "../../src/daemon/listChangedBroadcast";

// Minimal MCP-server stand-in: registerWithServer only calls registerTool (no-op
// here), tracks the server, and hooks the underlying Protocol onclose for
// pruning; notifyToolListChanged calls sendToolListChanged on every live server.

describe("ToolRegistry.notifyToolListChanged", () => {
  beforeEach(() => {
    // The registry singleton is shared across suites; drop servers registered
    // by other tests so counts here are hermetic.
    ToolRegistry.clearServersForTesting();
  });

  afterEach(() => {
    ToolRegistry.clearServersForTesting();
  });

  test("delegates to server.sendToolListChanged() after registerWithServer", () => {
    const server = new FakeMcpServer();
    ToolRegistry.registerWithServer(server);

    ToolRegistry.notifyToolListChanged();

    expect(server.calls).toBe(1);
  });

  test("swallows sendToolListChanged errors (best-effort, never throws)", () => {
    const server = new FakeMcpServer();
    server.shouldThrow = true;
    ToolRegistry.registerWithServer(server);

    expect(() => ToolRegistry.notifyToolListChanged()).not.toThrow();
    expect(server.calls).toBe(1);
  });

  test("fans out to every registered server, not just the last one (issue #3223)", () => {
    const first = new FakeMcpServer();
    const second = new FakeMcpServer();
    ToolRegistry.registerWithServer(first);
    ToolRegistry.registerWithServer(second);

    ToolRegistry.notifyToolListChanged();

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  test("one throwing server does not block sibling sessions", () => {
    const throwing = new FakeMcpServer();
    throwing.shouldThrow = true;
    const healthy = new FakeMcpServer();
    ToolRegistry.registerWithServer(throwing);
    ToolRegistry.registerWithServer(healthy);

    expect(() => ToolRegistry.notifyToolListChanged()).not.toThrow();
    expect(healthy.calls).toBe(1);
  });

  test("prunes a server when its underlying transport closes", () => {
    const closing = new FakeMcpServer();
    const surviving = new FakeMcpServer();
    ToolRegistry.registerWithServer(closing);
    ToolRegistry.registerWithServer(surviving);

    // Simulate the session teardown the SDK performs on transport close.
    closing.server.onclose?.();
    ToolRegistry.notifyToolListChanged();

    expect(closing.calls).toBe(0);
    expect(surviving.calls).toBe(1);
  });

  test("onclose prune chains a pre-existing onclose hook instead of clobbering it", () => {
    const server = new FakeMcpServer();
    let priorHookCalls = 0;
    server.server.onclose = () => {
      priorHookCalls += 1;
    };
    ToolRegistry.registerWithServer(server);

    server.server.onclose?.();

    expect(priorHookCalls).toBe(1);
  });

  test("re-registering the same server does not double-notify", () => {
    const server = new FakeMcpServer();
    ToolRegistry.registerWithServer(server);
    ToolRegistry.registerWithServer(server);

    ToolRegistry.notifyToolListChanged();

    expect(server.calls).toBe(1);
  });

  test("an ephemeral per-request server is never sent tools/list_changed (#4678)", () => {
    const ephemeral = new FakeMcpServer();
    const session = new FakeMcpServer();
    const kinds: string[] = [];
    const unsubscribe = ListChangedBroadcaster.subscribe((kind) => {
      kinds.push(kind);
    });
    try {
      ToolRegistry.registerWithServer(ephemeral, { ephemeral: true });
      ToolRegistry.registerWithServer(session);

      ToolRegistry.notifyToolListChanged();

      expect(ephemeral.calls).toBe(0);
      expect(session.calls).toBe(1);
      // Its clients learn of the change through the broadcaster instead.
      expect(kinds).toEqual(["tools"]);
    } finally {
      unsubscribe();
    }
  });

  test("ephemeral servers are tracked only until they close, so none leak", () => {
    const servers = Array.from({ length: 3 }, () => new FakeMcpServer());
    for (const server of servers) {
      ToolRegistry.registerWithServer(server, { ephemeral: true });
    }
    expect(ToolRegistry.trackedServerCountsForTesting()).toEqual({ notified: 0, ephemeral: 3 });

    for (const server of servers) {
      server.server.onclose?.();
    }

    expect(ToolRegistry.trackedServerCountsForTesting()).toEqual({ notified: 0, ephemeral: 0 });
  });

  test("notifyToolSelectionChanged fans out and broadcasts exactly like notifyToolListChanged", () => {
    const first = new FakeMcpServer();
    const second = new FakeMcpServer();
    second.shouldThrow = true;
    const ephemeral = new FakeMcpServer();
    ToolRegistry.registerWithServer(first);
    ToolRegistry.registerWithServer(second);
    ToolRegistry.registerWithServer(ephemeral, { ephemeral: true });
    const kinds: string[] = [];
    const unsubscribe = ListChangedBroadcaster.subscribe((kind) => {
      kinds.push(kind);
    });
    try {
      expect(() => ToolRegistry.notifyToolSelectionChanged()).not.toThrow();

      expect(first.calls).toBe(1);
      expect(second.calls).toBe(1);
      expect(ephemeral.calls).toBe(0);
      expect(kinds).toEqual(["tools"]);
    } finally {
      unsubscribe();
    }
  });

  test("emits on the ListChangedBroadcaster even with zero servers", () => {
    const kinds: string[] = [];
    const unsubscribe = ListChangedBroadcaster.subscribe((kind) => {
      kinds.push(kind);
    });
    try {
      ToolRegistry.notifyToolListChanged();
      expect(kinds).toEqual(["tools"]);
    } finally {
      unsubscribe();
    }
  });
});

describe("ToolRegistry session-binding release fan-out (issue #4611 Gap D)", () => {
  test("fans a released session UUID out to every registered handler and honors unsubscribe", () => {
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribeFirst = ToolRegistry.registerSessionBindingReleaseHandler({
      onSessionReleased: (uuid) => first.push(uuid),
    });
    const unsubscribeSecond = ToolRegistry.registerSessionBindingReleaseHandler({
      onSessionReleased: (uuid) => second.push(uuid),
    });
    try {
      ToolRegistry.notifySessionBindingReleased("session-1");
      expect(first).toEqual(["session-1"]);
      expect(second).toEqual(["session-1"]);

      unsubscribeFirst();
      ToolRegistry.notifySessionBindingReleased("session-2");
      // The unsubscribed handler stops receiving events; the survivor keeps going.
      expect(first).toEqual(["session-1"]);
      expect(second).toEqual(["session-1", "session-2"]);
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });

  test("one throwing handler does not block sibling handlers", () => {
    const healthy: string[] = [];
    const unsubscribeThrowing = ToolRegistry.registerSessionBindingReleaseHandler({
      onSessionReleased: () => {
        throw new Error("teardown boom");
      },
    });
    const unsubscribeHealthy = ToolRegistry.registerSessionBindingReleaseHandler({
      onSessionReleased: (uuid) => healthy.push(uuid),
    });
    try {
      expect(() => ToolRegistry.notifySessionBindingReleased("session-1")).not.toThrow();
      expect(healthy).toEqual(["session-1"]);
    } finally {
      unsubscribeThrowing();
      unsubscribeHealthy();
    }
  });
});
