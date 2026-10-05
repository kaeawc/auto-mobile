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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DaemonState } from "../../../src/daemon/daemonState";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import {
  ResourceRegistry,
  type ResourceContent,
  type ResourceReadContext,
} from "../../../src/server/resourceRegistry";
import { ResourceUpdatedBroadcaster } from "../../../src/server/listChangedBroadcast";
import {
  registerNavigationResources,
  setNavigationGraphProvider,
  setNavigationScreenshotProvider,
} from "../../../src/server/navigationResources";
import { installInMemoryNavManager } from "../../helpers/navigationTestHarness";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeMcpServer } from "../../fakes/FakeMcpServer";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";

const graphUri = "automobile:navigation/graph";
const historyUris = [
  "automobile:navigation/history",
  "automobile:navigation/history?limit=1",
  "automobile:navigation/history?cursor=0:0",
  "automobile:navigation/history?cursor=0:0&limit=1",
];

class FakeNavigationSessions {
  sessionIds = ["A", "B"];
  getAllSessions() {
    return this.sessionIds.map((sessionId) => ({ sessionId }));
  }
}

async function read(uri: string, context: ResourceReadContext = {}): Promise<ResourceContent> {
  const resource = ResourceRegistry.getResource(uri);
  if (resource) {
    return resource.handler(context);
  }
  const match = ResourceRegistry.matchTemplate(uri)!;
  return "handlerWithReadContext" in match.template
    ? match.template.handlerWithReadContext(match.params, context)
    : match.template.handler(match.params);
}

async function payload(uri: string, context: ResourceReadContext = {}) {
  return JSON.parse((await read(uri, context)).text!);
}

async function connect(context: ResourceReadContext): Promise<FakeMcpServer> {
  const server = new FakeMcpServer();
  ResourceRegistry.registerWithServer(server as unknown as McpServer, () => context);
  for (const uri of [graphUri, "automobile:navigation/history", "automobile:navigation/apps"]) {
    await server.server.handlersBySchema.get(SubscribeRequestSchema)!({ params: { uri } });
  }
  return server;
}

describe("navigation resource session resolution", () => {
  let harness: Awaited<ReturnType<typeof installInMemoryNavManager>>;
  let a: NavigationGraphManager;
  let b: NavigationGraphManager;
  let timer: FakeTimer;
  let sessions: FakeNavigationSessions;
  let initialized: ReturnType<typeof spyOn>;
  let sessionManager: ReturnType<typeof spyOn>;
  let timeout: ReturnType<typeof spyOn>;
  let clearTimeout: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
    const make = (id: string) =>
      NavigationGraphManager.createForTesting(
        new NavigationRepository(harness.db),
        new TestCoverageRepository(undefined, harness.db),
        new FakeTimer(),
        id,
      );
    a = make("A");
    b = make("B");
    for (const [manager, appId, screen] of [
      [a, "app.a", "HomeA"],
      [b, "app.b", "HomeB"],
    ] as const) {
      await manager.setCurrentApp(appId);
      await manager.recordNavigationEvent({
        destination: screen,
        source: "",
        arguments: {},
        metadata: {},
        timestamp: 1,
        sequenceNumber: 1,
      });
    }
    await harness.manager.setCurrentApp("launcher");
  });

  beforeEach(() => {
    timer = new FakeTimer();
    timeout = spyOn(defaultTimer, "setTimeout").mockImplementation((callback, ms) =>
      timer.setTimeout(callback, ms),
    );
    clearTimeout = spyOn(defaultTimer, "clearTimeout").mockImplementation((handle) =>
      timer.clearTimeout(handle),
    );
    sessions = new FakeNavigationSessions();
    initialized = spyOn(DaemonState.getInstance(), "isInitialized").mockReturnValue(true);
    sessionManager = spyOn(DaemonState.getInstance(), "getSessionManager").mockReturnValue(
      sessions as never,
    );
    NavigationGraphManager.setInstanceForTesting(harness.manager);
    NavigationGraphManager.setInstanceForSessionForTesting("A", a);
    NavigationGraphManager.setInstanceForSessionForTesting("B", b);
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
    setNavigationGraphProvider(null);
    registerNavigationResources();
  });

  afterEach(async () => {
    await timer.advanceTimeAsync(1000);
    ResourceRegistry.clearServersForTesting();
    setNavigationGraphProvider(null);
    setNavigationScreenshotProvider(null);
    timeout.mockRestore();
    clearTimeout.mockRestore();
    initialized.mockRestore();
    sessionManager.mockRestore();
    NavigationGraphManager.setSessionGraphUpdateListener(null);
  });

  afterAll(async () => {
    await harness.dispose();
    ResourceRegistry.clearResources();
  });

  test("bound graph reads use A and B's managers despite two sessions", async () => {
    for (const sessionUuid of ["A", "B"]) {
      const graph = await payload(graphUri, { sessionUuid });
      expect(graph.appId).toBe(`app.${sessionUuid.toLowerCase()}`);
      expect(graph.currentScreen).toBe(`Home${sessionUuid}`);
      expect(graph.nodes).toHaveLength(1);
    }
  });

  test("registry forwards the connection binding to the graph handler", async () => {
    const server = await connect({ sessionUuid: "B" });
    const result = (await server.server.handlersBySchema.get(ReadResourceRequestSchema)!(
      { params: { uri: graphUri } },
      { signal: new AbortController().signal },
    )) as { contents: ResourceContent[] };
    expect(JSON.parse(result.contents[0]!.text!).currentScreen).toBe("HomeB");
  });

  test("all history variants resolve both bound sessions", async () => {
    for (const uri of historyUris) {
      for (const sessionUuid of ["A", "B"]) {
        const history = await payload(uri, { sessionUuid });
        expect(history.appId).toBe(`app.${sessionUuid.toLowerCase()}`);
        expect(history.currentScreen).toBe(`Home${sessionUuid}`);
        expect(history.nodes[0].screenName).toBe(`Home${sessionUuid}`);
      }
    }
  });

  test("unbound current-app resources report ambiguity with a remedy", async () => {
    const nodeId = (await a.exportGraphSummary()).nodes[0]!.id;
    for (const uri of [
      graphUri,
      ...historyUris,
      `automobile:navigation/nodes/${nodeId}`,
      "automobile:navigation/nodes?screen=HomeA",
      `automobile:navigation/nodes/${nodeId}/screenshot`,
      "automobile:navigation/test-coverage",
    ]) {
      const body = await payload(uri);
      expect(body.error).toContain("Multiple device sessions");
      expect(body.error).toContain("session-bound connection");
    }
  });

  test("sole-session and zero-session fallback stay unchanged", async () => {
    sessions.sessionIds = ["A"];
    expect((await payload(graphUri)).appId).toBe("app.a");
    expect((await payload(historyUris[0]!)).currentScreen).toBe("HomeA");
    sessions.sessionIds = [];
    expect((await payload(graphUri)).appId).toBe("launcher");
    expect((await payload(historyUris[0]!)).appId).toBe("launcher");
    initialized.mockReturnValue(false);
    expect((await payload(graphUri)).appId).toBe("launcher");
    expect((await payload(graphUri, { sessionUuid: "A" })).appId).toBe("app.a");
  });

  test("scoped graph, build lenses, nodes and screenshots remain available with two sessions", async () => {
    const nodeId = (await a.exportGraphSummary()).nodes[0]!.id;
    setNavigationScreenshotProvider({
      async findExistingScreenshot(appId, screen) {
        return `${appId}/${screen}`;
      },
      async readScreenshot(path) {
        return Buffer.from(path);
      },
    });
    for (const context of [{}, { sessionUuid: "B" }]) {
      expect((await payload(`${graphUri}?appId=app.a`, context)).nodes[0].screenName).toBe("HomeA");
      expect(
        (
          await payload(
            `${graphUri}/build-filter?appId=app.a&versionCode=0&contentHash=legacy`,
            context,
          )
        ).error,
      ).toBeUndefined();
      expect(
        (
          await payload(
            `${graphUri}/build-diff?appId=app.a&versionCodeA=0&contentHashA=legacy&versionCodeB=1&contentHashB=other`,
            context,
          )
        ).error,
      ).toBeUndefined();
      expect(
        (await payload(`automobile:navigation/nodes/${nodeId}?appId=app.a`, context)).node
          .screenName,
      ).toBe("HomeA");
      expect(
        (await read(`automobile:navigation/nodes/${nodeId}/screenshot?appId=app.a`, context)).blob,
      ).toBe(Buffer.from("app.a/HomeA").toString("base64"));
    }
  });

  test("unscoped nodes and screenshots use the bound current app", async () => {
    const nodeId = (await a.exportGraphSummary()).nodes[0]!.id;
    setNavigationScreenshotProvider({
      async findExistingScreenshot(appId, screen) {
        return `${appId}/${screen}`;
      },
      async readScreenshot(path) {
        return Buffer.from(path);
      },
    });
    expect(
      (await payload(`automobile:navigation/nodes/${nodeId}`, { sessionUuid: "A" }))
        .isCurrentScreen,
    ).toBe(true);
    expect(
      (await payload("automobile:navigation/nodes?screen=HomeB", { sessionUuid: "B" }))
        .isCurrentScreen,
    ).toBe(true);
    expect(
      (await read(`automobile:navigation/nodes/${nodeId}/screenshot`, { sessionUuid: "A" })).blob,
    ).toBe(Buffer.from("app.a/HomeA").toString("base64"));
  });

  test("persisted apps and static resource definitions do not need session attribution", async () => {
    const apps = await payload("automobile:navigation/apps");
    expect(apps.apps.map((app: { appId: string }) => app.appId).sort()).toEqual(["app.a", "app.b"]);
    expect(
      ResourceRegistry.getResourceDefinitions().some((resource) => resource.uri === graphUri),
    ).toBe(true);
  });

  test("injected providers override bound and ambiguous session resolution", async () => {
    const fake = new FakeNavigationGraphManager();
    fake.setCurrentAppId("injected");
    setNavigationGraphProvider(fake);
    expect((await payload(graphUri, { sessionUuid: "A" })).appId).toBe("injected");
    expect((await payload(historyUris[1]!)).appId).toBe("injected");
    registerNavigationResources({ navigationGraph: fake });
    expect((await payload(graphUri)).appId).toBe("injected");
  });

  test("replacing an injected provider cancels its pending global debounce", async () => {
    const server = await connect({ sessionUuid: "A" });
    const previous = new FakeNavigationGraphManager();
    const replacement = new FakeNavigationGraphManager();
    setNavigationGraphProvider(previous);
    previous.setCurrentApp("old");
    setNavigationGraphProvider(replacement);
    replacement.setCurrentApp("new");
    await timer.advanceTimeAsync(1000);
    expect(server.server.notifications).toHaveLength(3);
    expect((await payload(graphUri)).appId).toBe("new");
  });

  test("overlapping session updates debounce independently and preserve sibling listeners", async () => {
    const first = await connect({ sessionUuid: "A" });
    const second = await connect({ sessionUuid: "B" });
    let pushes = 0;
    const listener = () => {
      pushes++;
    };
    a.setGraphUpdateListener(listener);
    registerNavigationResources();
    registerNavigationResources();
    try {
      await a.setCurrentApp("app.a.burst");
      await a.setCurrentApp("app.a");
      await b.setCurrentApp("app.b.burst");
      await b.setCurrentApp("app.b");
      await timer.advanceTimeAsync(1000);
      expect(pushes).toBe(2);
      expect(first.server.notifications).toHaveLength(3);
      expect(second.server.notifications).toHaveLength(3);
    } finally {
      a.removeGraphUpdateListener(listener);
    }
  });

  test("socket broadcaster retains its subscription-only legacy fan-out", async () => {
    const notifications: string[] = [];
    const unsubscribe = ResourceUpdatedBroadcaster.subscribe((resolveTargets) => {
      notifications.push(...resolveTargets(new Set([graphUri])));
    });
    try {
      await ResourceRegistry.notifyResourceUpdated(graphUri, "A");
      expect(notifications).toEqual([graphUri]);
    } finally {
      unsubscribe();
    }
  });

  test("session update debounce notifies only owning MCP connections; global fan-out stays", async () => {
    const first = await connect({ sessionUuid: "A" });
    const second = await connect({ sessionUuid: "B" });
    const owner = await connect({ sessionUuid: "other", ownsSession: (id) => id === "A" });
    await a.setCurrentApp("app.a.update");
    await timer.advanceTimeAsync(1000);
    expect(first.server.notifications).toHaveLength(3);
    expect(owner.server.notifications).toHaveLength(3);
    expect(second.server.notifications).toHaveLength(0);
    first.server.notifications.length = 0;
    owner.server.notifications.length = 0;
    await b.setCurrentApp("app.b.update");
    await timer.advanceTimeAsync(1000);
    expect(first.server.notifications).toHaveLength(0);
    expect(owner.server.notifications).toHaveLength(0);
    expect(second.server.notifications).toHaveLength(3);
    await harness.manager.setCurrentApp("global.update");
    await timer.advanceTimeAsync(1000);
    expect(first.server.notifications).toHaveLength(3);
    expect(second.server.notifications).toHaveLength(6);
    await a.setCurrentApp("app.a");
    await b.setCurrentApp("app.b");
  });
});
