import { describe, expect, test } from "bun:test";
import {
  NavigationGraphStreamBridge,
  isHeldByAnotherSession,
  logSkippedObservationStreamDevice,
  type NavigationGraphBridgeSource,
  type NavigationGraphPushTarget,
} from "../../src/daemon/daemonStreamRouting";

function fakeManager(contexts: Array<{ deviceId: string; appId: string }> = []) {
  const manager = {
    listenerSets: 0,
    getBuildContexts: () =>
      contexts.map((context) => ({ ...context, versionCode: 1, contentHash: "h" })),
    setBuildContextUpdateListener: () => {
      manager.listenerSets += 1;
    },
    setGraphUpdateListener: () => {},
    exportGraphSummary: async () => {
      throw new Error("unused");
    },
    exportGraphSummaryForApp: async () => {
      throw new Error("unused");
    },
    getDeviceIdForApp: () => null,
  } satisfies NavigationGraphBridgeSource & { listenerSets: number };
  return manager;
}

function fakeServer() {
  const pushed: string[] = [];
  let requestHandlerSet = 0;
  const server = {
    pushBuildContextUpdate: (deviceId: string, appId: string) => {
      pushed.push(`${deviceId}/${appId}`);
    },
    pushNavigationGraphUpdate: () => {},
    setOnNavigationGraphRequested: () => {
      requestHandlerSet += 1;
    },
  } satisfies NavigationGraphPushTarget;
  return { server, pushed, requestHandlerSets: () => requestHandlerSet };
}

describe("NavigationGraphStreamBridge", () => {
  test("listen wires the default and every session manager once and installs the request handler", () => {
    const { server, requestHandlerSets } = fakeServer();
    const base = fakeManager();
    const session = fakeManager();
    const bridge = new NavigationGraphStreamBridge({
      server: () => server,
      sessionIds: () => ["s1"],
      defaultManager: () => base,
      managerForSession: () => session,
    });
    bridge.listen(server);
    bridge.listen(server);
    expect(base.listenerSets).toBe(1);
    expect(session.listenerSets).toBe(1);
    expect(requestHandlerSets()).toBe(2);
    expect(bridge.listenerManagers.has(base)).toBe(true);
  });

  test("listen without a stream server wires nothing", () => {
    const base = fakeManager();
    const bridge = new NavigationGraphStreamBridge({
      server: () => null,
      sessionIds: () => [],
      defaultManager: () => base,
      managerForSession: () => base,
    });
    bridge.listen(null);
    expect(base.listenerSets).toBe(0);
  });

  test("a replacement server is seeded again for an already-wired manager", () => {
    const first = fakeServer();
    const second = fakeServer();
    let current = first.server;
    const manager = fakeManager([{ deviceId: "d", appId: "a" }]);
    const bridge = new NavigationGraphStreamBridge({
      server: () => current,
      sessionIds: () => [],
      defaultManager: () => manager,
      managerForSession: () => manager,
    });
    bridge.attach(manager);
    bridge.attach(manager);
    current = second.server;
    bridge.attach(manager);
    expect(first.pushed).toEqual(["d/a"]);
    expect(second.pushed).toEqual(["d/a"]);
    expect(manager.listenerSets).toBe(1);
  });
});

describe("isHeldByAnotherSession", () => {
  const deps = (holder: string | undefined, poolHolder?: string) => ({
    sessionManager: {
      getSessionForDevice: () => holder,
      getDeviceLabels: () => undefined,
    },
    devicePool: {
      getDevice: () => (poolHolder === undefined ? null : { sessionId: poolHolder }),
    },
  });

  test("an unheld device is not held by another session", () => {
    expect(isHeldByAnotherSession(deps(undefined), "d", "me")).toBe(false);
  });

  test("the requester's own hold is not another session", () => {
    expect(isHeldByAnotherSession(deps("me"), "d", "me")).toBe(false);
  });

  test("a different holder, from the manager or the pool, is another session", () => {
    expect(isHeldByAnotherSession(deps("other"), "d", "me")).toBe(true);
    expect(isHeldByAnotherSession(deps(undefined, "other"), "d", "me")).toBe(true);
    expect(isHeldByAnotherSession(deps("other"), "d", undefined)).toBe(true);
  });
});

describe("logSkippedObservationStreamDevice", () => {
  test("does not throw for either platform", () => {
    expect(() => logSkippedObservationStreamDevice("android", "d", "connect")).not.toThrow();
    expect(() => logSkippedObservationStreamDevice("ios", "d", "connect")).not.toThrow();
    expect(() => logSkippedObservationStreamDevice("watchos", "d", "connect")).not.toThrow();
  });
});
