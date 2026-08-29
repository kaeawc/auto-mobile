import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";
import {
  NAVIGATION_RESOURCE_URIS,
  NavigationGraphResourceContent,
  NavigationNodeResourceContent,
  NavigationAppsResourceContent,
  setNavigationGraphProvider,
  setNavigationScreenshotProvider,
} from "../../../src/server/navigationResources";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { ResourceRegistry } from "../../../src/server/resourceRegistry";
import { z } from "zod/v4";

describe("MCP Navigation Graph Resource", () => {
  let fixture: McpTestFixture;
  let fakeGraph: FakeNavigationGraphManager;

  beforeAll(async () => {
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  beforeEach(() => {
    fakeGraph = new FakeNavigationGraphManager();
    setNavigationGraphProvider(fakeGraph);
  });

  afterEach(() => {
    setNavigationGraphProvider(null);
    setNavigationScreenshotProvider(null);
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
  });

  test("should include navigation graph resource in list", async () => {
    const { client } = fixture.getContext();

    const listResourcesResponseSchema = z.object({
      resources: z.array(
        z.object({
          uri: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/list",
        params: {},
      },
      listResourcesResponseSchema,
    );

    const resource = result.resources.find((r: any) => r.uri === NAVIGATION_RESOURCE_URIS.GRAPH);

    expect(resource).toBeDefined();
    expect(resource?.name).toBe("Navigation Graph");
    expect(resource?.mimeType).toBe("application/json");
  });

  test("should return high-level graph summary", async () => {
    fakeGraph.setCurrentAppId("com.example.app");
    fakeGraph.setCurrentScreenValue("Home");
    fakeGraph.addNode({
      screenName: "Home",
      firstSeenAt: 100,
      lastSeenAt: 200,
      visitCount: 2,
    });
    fakeGraph.addNode({
      screenName: "Settings",
      firstSeenAt: 150,
      lastSeenAt: 250,
      visitCount: 1,
    });
    fakeGraph.addEdge({
      from: "Home",
      to: "Settings",
      timestamp: 250,
      edgeType: "tool",
      interaction: {
        toolName: "tapOn",
        args: {},
        timestamp: 250,
      },
    });

    const { client } = fixture.getContext();
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: NAVIGATION_RESOURCE_URIS.GRAPH,
        },
      },
      readResourceResponseSchema,
    );

    const content = result.contents[0];
    expect(content.uri).toBe(NAVIGATION_RESOURCE_URIS.GRAPH);
    expect(content.mimeType).toBe("application/json");
    expect(content.text).toBeDefined();

    const graph: NavigationGraphResourceContent = JSON.parse(content.text!);
    expect(graph.appId).toBe("com.example.app");
    expect(graph.currentScreen).toBe("Home");
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes[0]?.id).toBeDefined();
    expect(graph.edges[0]?.toolName).toBe("tapOn");
  });

  test("should include navigation node templates in list", async () => {
    const { client } = fixture.getContext();

    const listResourceTemplatesResponseSchema = z.object({
      resourceTemplates: z.array(
        z.object({
          uriTemplate: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/templates/list",
        params: {},
      },
      listResourceTemplatesResponseSchema,
    );

    const nodeByIdTemplate = result.resourceTemplates.find(
      (t: any) => t.uriTemplate === NAVIGATION_RESOURCE_URIS.NODE_BY_ID,
    );
    const nodeByScreenTemplate = result.resourceTemplates.find(
      (t: any) => t.uriTemplate === NAVIGATION_RESOURCE_URIS.NODE_BY_SCREEN,
    );

    expect(nodeByIdTemplate).toBeDefined();
    expect(nodeByScreenTemplate).toBeDefined();
  });

  test("should return navigation node resource by id", async () => {
    fakeGraph.setCurrentAppId("com.example.app");
    fakeGraph.setCurrentScreenValue("Home");
    fakeGraph.addNode({
      screenName: "Home",
      firstSeenAt: 100,
      lastSeenAt: 200,
      visitCount: 2,
    });
    fakeGraph.addNode({
      screenName: "Settings",
      firstSeenAt: 150,
      lastSeenAt: 250,
      visitCount: 1,
    });
    fakeGraph.addEdge({
      from: "Home",
      to: "Settings",
      timestamp: 250,
      edgeType: "tool",
      interaction: {
        toolName: "tapOn",
        args: {},
        timestamp: 250,
      },
    });

    const { client } = fixture.getContext();
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: "automobile:navigation/nodes/1",
        },
      },
      readResourceResponseSchema,
    );

    const content = result.contents[0];
    expect(content.text).toBeDefined();

    const nodeResource: NavigationNodeResourceContent = JSON.parse(content.text!);
    expect(nodeResource.node.id).toBe(1);
    expect(nodeResource.node.screenName).toBe("Home");
    expect(nodeResource.isCurrentScreen).toBe(true);
    expect(nodeResource.edgesFrom).toHaveLength(1);
    expect(nodeResource.edgesTo).toHaveLength(0);
  });

  test("should include navigation apps resource in list", async () => {
    const { client } = fixture.getContext();

    const listResourcesResponseSchema = z.object({
      resources: z.array(
        z.object({
          uri: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/list",
        params: {},
      },
      listResourcesResponseSchema,
    );

    const resource = result.resources.find((r: any) => r.uri === NAVIGATION_RESOURCE_URIS.APPS);

    expect(resource).toBeDefined();
    expect(resource?.name).toBe("Navigation Apps");
    expect(resource?.mimeType).toBe("application/json");
  });

  test("should list apps that have a persisted navigation graph", async () => {
    fakeGraph.setAppsWithGraph([
      { appId: "com.example.b", displayName: null, lastUpdated: "2026-01-02T00:00:00.000Z" },
      { appId: "com.example.a", displayName: null, lastUpdated: "2026-01-01T00:00:00.000Z" },
    ]);

    const { client } = fixture.getContext();
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: NAVIGATION_RESOURCE_URIS.APPS,
        },
      },
      readResourceResponseSchema,
    );

    const content = result.contents[0];
    expect(content.uri).toBe(NAVIGATION_RESOURCE_URIS.APPS);
    expect(content.mimeType).toBe("application/json");
    expect(content.text).toBeDefined();

    const payload: NavigationAppsResourceContent = JSON.parse(content.text!);
    expect(payload.apps).toHaveLength(2);
    expect(payload.apps[0]?.appId).toBe("com.example.b");
    expect(payload.apps[0]?.lastUpdated).toBe("2026-01-02T00:00:00.000Z");
    expect(payload.apps[0]?.displayName).toBeNull();
    expect(payload.apps[1]?.appId).toBe("com.example.a");
  });

  test("should return an empty list when no apps have a persisted graph", async () => {
    const { client } = fixture.getContext();
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: NAVIGATION_RESOURCE_URIS.APPS,
        },
      },
      readResourceResponseSchema,
    );

    const content = result.contents[0];
    expect(content.text).toBeDefined();

    const payload: NavigationAppsResourceContent = JSON.parse(content.text!);
    expect(payload.apps).toEqual([]);
  });

  test("should return navigation node resource by screen name", async () => {
    fakeGraph.setCurrentAppId("com.example.app");
    fakeGraph.setCurrentScreenValue("Home");
    fakeGraph.addNode({
      screenName: "Home",
      firstSeenAt: 100,
      lastSeenAt: 200,
      visitCount: 2,
    });
    fakeGraph.addNode({
      screenName: "Settings",
      firstSeenAt: 150,
      lastSeenAt: 250,
      visitCount: 1,
    });
    fakeGraph.addEdge({
      from: "Home",
      to: "Settings",
      timestamp: 250,
      edgeType: "tool",
      interaction: {
        toolName: "tapOn",
        args: {},
        timestamp: 250,
      },
    });

    const { client } = fixture.getContext();
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: "automobile:navigation/nodes?screen=Settings",
        },
      },
      readResourceResponseSchema,
    );

    const content = result.contents[0];
    expect(content.text).toBeDefined();

    const nodeResource: NavigationNodeResourceContent = JSON.parse(content.text!);
    expect(nodeResource.node.screenName).toBe("Settings");
    expect(nodeResource.isCurrentScreen).toBe(false);
    expect(nodeResource.edgesFrom).toHaveLength(0);
    expect(nodeResource.edgesTo).toHaveLength(1);
  });

  test("should include app-specific node + screenshot templates in list", async () => {
    const { client } = fixture.getContext();

    const listResourceTemplatesResponseSchema = z.object({
      resourceTemplates: z.array(
        z.object({
          uriTemplate: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/templates/list",
        params: {},
      },
      listResourceTemplatesResponseSchema,
    );

    const nodeByIdAppTemplate = result.resourceTemplates.find(
      (t: any) => t.uriTemplate === NAVIGATION_RESOURCE_URIS.NODE_BY_ID_WITH_APP_ID,
    );
    const screenshotAppTemplate = result.resourceTemplates.find(
      (t: any) => t.uriTemplate === NAVIGATION_RESOURCE_URIS.NODE_SCREENSHOT_WITH_APP_ID,
    );

    expect(nodeByIdAppTemplate).toBeDefined();
    expect(screenshotAppTemplate).toBeDefined();
  });

  test("node-by-id ?appId= resolves under the requested app, not the current app", async () => {
    // Foreground app is A; the node is browsed under app B (offline browse, #4933).
    fakeGraph.setCurrentAppId("com.example.a");
    fakeGraph.setCurrentScreenValue("Home");
    fakeGraph.addNode({
      screenName: "Home",
      firstSeenAt: 100,
      lastSeenAt: 200,
      visitCount: 2,
    });

    const { client } = fixture.getContext();
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: { uri: "automobile:navigation/nodes/1?appId=com.example.b" },
      },
      readResourceResponseSchema,
    );

    const content = result.contents[0];
    expect(content.uri).toBe("automobile:navigation/nodes/1?appId=com.example.b");

    const nodeResource: NavigationNodeResourceContent = JSON.parse(content.text!);
    expect(nodeResource.appId).toBe("com.example.b");
    expect(nodeResource.node.screenName).toBe("Home");
    // Reading under a non-foreground app is never the current screen.
    expect(nodeResource.isCurrentScreen).toBe(false);
  });

  test("screenshot ?appId= resolves under the requested app, not a colliding current app", async () => {
    // Foreground app A also has a "Home" screen; browsing app B must not leak A's.
    fakeGraph.setCurrentAppId("com.example.a");
    fakeGraph.setCurrentScreenValue("Home");
    fakeGraph.addNode({
      screenName: "Home",
      firstSeenAt: 100,
      lastSeenAt: 200,
      visitCount: 1,
    });

    // App-scoped screenshot store: content is keyed by (appId, screenName).
    setNavigationScreenshotProvider({
      async findExistingScreenshot(appId: string, screenName: string) {
        return `/screens/${appId}/${screenName}.webp`;
      },
      async readScreenshot(screenshotPath: string) {
        return Buffer.from(`bytes:${screenshotPath}`);
      },
    });

    const { client } = fixture.getContext();
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          blob: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: { uri: "automobile:navigation/nodes/1/screenshot?appId=com.example.b" },
      },
      readResourceResponseSchema,
    );

    const content = result.contents[0];
    expect(content.uri).toBe("automobile:navigation/nodes/1/screenshot?appId=com.example.b");
    expect(content.mimeType).toBe("image/webp");
    expect(content.blob).toBeDefined();

    const decoded = Buffer.from(content.blob!, "base64").toString("utf8");
    // Resolved from app B's store, not the foreground app A's colliding screen.
    expect(decoded).toBe("bytes:/screens/com.example.b/Home.webp");
    expect(decoded).not.toContain("com.example.a");
  });

  test("screenshot ?appId= reports not-found without leaking the current app's screenshot", async () => {
    fakeGraph.setCurrentAppId("com.example.a");
    fakeGraph.setCurrentScreenValue("Home");
    fakeGraph.addNode({
      screenName: "Home",
      firstSeenAt: 100,
      lastSeenAt: 200,
      visitCount: 1,
    });

    // App B has no screenshot for this screen.
    setNavigationScreenshotProvider({
      async findExistingScreenshot(appId: string) {
        return appId === "com.example.a" ? "/screens/com.example.a/Home.webp" : null;
      },
      async readScreenshot(screenshotPath: string) {
        return Buffer.from(`bytes:${screenshotPath}`);
      },
    });

    const { client } = fixture.getContext();
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          blob: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: { uri: "automobile:navigation/nodes/1/screenshot?appId=com.example.b" },
      },
      readResourceResponseSchema,
    );

    const content = result.contents[0];
    expect(content.blob).toBeUndefined();
    expect(content.mimeType).toBe("application/json");
    const payload = JSON.parse(content.text!);
    expect(payload.error).toContain("No screenshot available");
  });

  // #5748: sibling of #5686. storageCapabilities double-decoded appId because its
  // RFC-6570 `{?appId}` template makes the registry URL-decode the query param, so
  // the handler's second decodeURIComponent was redundant. These navigation
  // templates use the literal `?appId={appId}` form instead, which the registry
  // captures as a RAW regex group (no URLSearchParams) — so navigation's single
  // decodeURIComponent is correct and must NOT be removed. What navigation still
  // needed was to stop that decode throwing an uncaught URIError past the
  // handler's try/catch on a malformed `%` (the other harm #5686 flagged).
  describe("appId query param is single-decoded, not double-decoded (#5748)", () => {
    test("registry hands the handler the RAW query param (not URLSearchParams-decoded)", () => {
      // URI value %2541: a double-decode path (storageCapabilities' `{?appId}`)
      // would hand the handler "%41"; navigation's literal `?appId=` template
      // captures it raw, so the single handler decode is the first-and-only one.
      const match = ResourceRegistry.matchTemplate("automobile:navigation/graph?appId=%2541");
      expect(match?.template.uriTemplate).toBe(NAVIGATION_RESOURCE_URIS.GRAPH_WITH_APP_ID);
      expect(match?.params.appId).toBe("%2541");
    });

    test("a %-bearing appId round-trips through the resource (identity contract)", async () => {
      fakeGraph.setCurrentAppId("com.example.a");
      fakeGraph.addNode({
        screenName: "Home",
        firstSeenAt: 100,
        lastSeenAt: 200,
        visitCount: 1,
      });

      const { client } = fixture.getContext();
      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
          }),
        ),
      });

      // URI value 100%25 → single decode → "100%". Same external contract as
      // #5686 (100%25 → "100%"), reached via regex capture + one decode here.
      const result = await client.request(
        {
          method: "resources/read",
          params: { uri: "automobile:navigation/nodes/1?appId=100%25" },
        },
        readResourceResponseSchema,
      );

      const content = result.contents[0];
      const nodeResource: NavigationNodeResourceContent = JSON.parse(content.text!);
      expect(nodeResource.appId).toBe("100%");
    });

    test("a literal-% appId returns a graceful JSON envelope, not an uncaught URIError", async () => {
      fakeGraph.setCurrentAppId("com.example.a");
      fakeGraph.addNode({
        screenName: "Home",
        firstSeenAt: 100,
        lastSeenAt: 200,
        visitCount: 1,
      });

      const { client } = fixture.getContext();
      const readResourceResponseSchema = z.object({
        contents: z.array(
          z.object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string().optional(),
          }),
        ),
      });

      // Raw "100%" is not a valid percent-sequence: decodeURIComponent throws.
      // The decode runs outside the handler's try/catch, so before the fix this
      // URIError escaped the JSON error envelope and failed the read.
      const result = await client.request(
        {
          method: "resources/read",
          params: { uri: "automobile:navigation/graph?appId=100%" },
        },
        readResourceResponseSchema,
      );

      const content = result.contents[0];
      expect(content.mimeType).toBe("application/json");
      // Deliberate contract: a malformed `%` appId degrades to a normal graph
      // envelope (its fields present, no `error`), NOT an uncaught URIError and
      // NOT a bespoke malformed-input rejection. This mirrors #5686, which treats
      // a `%`-bearing id as an ordinary (here, unknown) app id rather than
      // rejecting it — decoding is best-effort, so an unresolvable id degrades the
      // same way any unknown id does. Asserting the shape (not just "some JSON
      // parses") pins that intended degradation.
      const body = JSON.parse(content.text!);
      expect(body.error).toBeUndefined();
      expect(Array.isArray(body.nodes)).toBe(true);
    });
  });

  // #5853: siblings of #5748. The `screenName`, `cursor`, and `limit` params were
  // decoded (and `limit` validated) OUTSIDE each handler's try/catch, so a
  // malformed percent-sequence (or an invalid `limit`) threw past the JSON error
  // envelope and surfaced as JSON-RPC -32603 instead. Same guarded-decode contract
  // as the `{?appId}` fix: a bad param degrades to the resource's own JSON envelope.
  describe("screen/cursor/limit params are guarded against uncaught URIError (#5853)", () => {
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    });

    test("a literal-% screen name returns a graceful JSON envelope, not an uncaught URIError", async () => {
      fakeGraph.setCurrentAppId("com.example.a");
      fakeGraph.addNode({
        screenName: "Home",
        firstSeenAt: 100,
        lastSeenAt: 200,
        visitCount: 1,
      });

      const { client } = fixture.getContext();

      // Raw "100%" is not a valid percent-sequence: decodeURIComponent throws.
      // Before the fix, that URIError escaped the handler's try/catch and failed
      // the read with -32603. Now the guarded decode degrades to the raw value,
      // which resolves to no node → the resource's normal not-found JSON envelope.
      const result = await client.request(
        {
          method: "resources/read",
          params: { uri: "automobile:navigation/nodes?screen=100%" },
        },
        readResourceResponseSchema,
      );

      const content = result.contents[0];
      expect(content.mimeType).toBe("application/json");
      const body = JSON.parse(content.text!);
      expect(typeof body.error).toBe("string");
      expect(body.error).toContain("not found");
    });

    test("a literal-% cursor returns a graceful JSON envelope, not an uncaught URIError", async () => {
      fakeGraph.setCurrentAppId("com.example.a");

      const { client } = fixture.getContext();

      // "100%" is a malformed cursor; the guarded decode degrades to the raw value
      // and the history export proceeds, returning its normal JSON page instead of
      // throwing a URIError past the handler.
      const result = await client.request(
        {
          method: "resources/read",
          params: { uri: "automobile:navigation/history?cursor=100%" },
        },
        readResourceResponseSchema,
      );

      const content = result.contents[0];
      expect(content.mimeType).toBe("application/json");
      const body = JSON.parse(content.text!);
      expect(body.error).toBeUndefined();
      expect(Array.isArray(body.nodes)).toBe(true);
    });

    test("a literal-% limit returns a graceful JSON error envelope, not an uncaught URIError", async () => {
      fakeGraph.setCurrentAppId("com.example.a");

      const { client } = fixture.getContext();

      // "100%" decodes (guarded) to the raw value, which is not a finite positive
      // number, so parseHistoryParams throws a plain Error. Before the fix that
      // throw was uncaught (-32603); now historyHandler catches it and returns the
      // resource's JSON error envelope.
      const result = await client.request(
        {
          method: "resources/read",
          params: { uri: "automobile:navigation/history?limit=100%" },
        },
        readResourceResponseSchema,
      );

      const content = result.contents[0];
      expect(content.mimeType).toBe("application/json");
      const body = JSON.parse(content.text!);
      expect(typeof body.error).toBe("string");
      expect(body.error).toContain("limit");
    });

    test("a non-numeric limit returns a graceful JSON error envelope, not an uncaught throw", async () => {
      fakeGraph.setCurrentAppId("com.example.a");

      const { client } = fixture.getContext();

      // Well-formed but invalid limit: parseHistoryParams throws a plain Error that
      // is likewise uncaught before the fix. historyHandler must catch it too.
      const result = await client.request(
        {
          method: "resources/read",
          params: { uri: "automobile:navigation/history?limit=abc" },
        },
        readResourceResponseSchema,
      );

      const content = result.contents[0];
      expect(content.mimeType).toBe("application/json");
      const body = JSON.parse(content.text!);
      expect(typeof body.error).toBe("string");
      expect(body.error).toContain("limit");
    });
  });
});
