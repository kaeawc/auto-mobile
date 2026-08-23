import { beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ListChangedBroadcaster } from "../../src/server/listChangedBroadcast";

// Minimal MCP-server stand-in: registerWithServer only calls registerTool (no-op
// here), tracks the server, and hooks the underlying Protocol onclose for
// pruning; notifyToolListChanged calls sendToolListChanged on every live server.
class FakeMcpServer {
  calls = 0;
  shouldThrow = false;
  // Underlying Protocol stand-in — registerWithServer chains `onclose` here.
  server: { onclose?: () => void } = {};
  registerTool(): void {
    // no-op — we only care about the notify path
  }
  sendToolListChanged(): void {
    this.calls += 1;
    if (this.shouldThrow) {
      throw new Error("send boom");
    }
  }
}

describe("ToolRegistry.notifyToolListChanged", () => {
  beforeEach(() => {
    // The registry singleton is shared across suites; drop servers registered
    // by other tests so counts here are hermetic.
    ToolRegistry.clearServersForTesting();
  });

  test("delegates to server.sendToolListChanged() after registerWithServer", () => {
    const server = new FakeMcpServer();
    ToolRegistry.registerWithServer(server as unknown as McpServer);

    ToolRegistry.notifyToolListChanged();

    expect(server.calls).toBe(1);
  });

  test("swallows sendToolListChanged errors (best-effort, never throws)", () => {
    const server = new FakeMcpServer();
    server.shouldThrow = true;
    ToolRegistry.registerWithServer(server as unknown as McpServer);

    expect(() => ToolRegistry.notifyToolListChanged()).not.toThrow();
    expect(server.calls).toBe(1);
  });

  test("fans out to every registered server, not just the last one (issue #3223)", () => {
    const first = new FakeMcpServer();
    const second = new FakeMcpServer();
    ToolRegistry.registerWithServer(first as unknown as McpServer);
    ToolRegistry.registerWithServer(second as unknown as McpServer);

    ToolRegistry.notifyToolListChanged();

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  test("one throwing server does not block sibling sessions", () => {
    const throwing = new FakeMcpServer();
    throwing.shouldThrow = true;
    const healthy = new FakeMcpServer();
    ToolRegistry.registerWithServer(throwing as unknown as McpServer);
    ToolRegistry.registerWithServer(healthy as unknown as McpServer);

    expect(() => ToolRegistry.notifyToolListChanged()).not.toThrow();
    expect(healthy.calls).toBe(1);
  });

  test("prunes a server when its underlying transport closes", () => {
    const closing = new FakeMcpServer();
    const surviving = new FakeMcpServer();
    ToolRegistry.registerWithServer(closing as unknown as McpServer);
    ToolRegistry.registerWithServer(surviving as unknown as McpServer);

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
    ToolRegistry.registerWithServer(server as unknown as McpServer);

    server.server.onclose?.();

    expect(priorHookCalls).toBe(1);
  });

  test("re-registering the same server does not double-notify", () => {
    const server = new FakeMcpServer();
    ToolRegistry.registerWithServer(server as unknown as McpServer);
    ToolRegistry.registerWithServer(server as unknown as McpServer);

    ToolRegistry.notifyToolListChanged();

    expect(server.calls).toBe(1);
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
