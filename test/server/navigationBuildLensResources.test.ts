import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import {
  NAVIGATION_RESOURCE_URIS,
  setNavigationGraphProvider,
  type NavigationBuildDiffResourceContent,
  type NavigationBuildFilterResourceContent,
} from "../../src/server/navigationResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import type {
  NavigationGraphSummary,
  NavigationProvenanceBuildKey,
} from "../../src/utils/interfaces/NavigationGraph";

const buildA: NavigationProvenanceBuildKey = {
  packageId: "com.example.app",
  versionCode: 1,
  contentHash: "a",
};
const buildB: NavigationProvenanceBuildKey = {
  packageId: "com.example.app",
  versionCode: 2,
  contentHash: "b",
};
const observed = (buildKey: NavigationProvenanceBuildKey) => ({
  buildKey,
  deviceId: "device",
  sessionUuid: "session",
  lastSeen: 1,
});
const summary: NavigationGraphSummary = {
  appId: "com.example.app",
  currentScreen: "Home",
  nodes: [
    { id: 1, screenName: "Home", visitCount: 1, provenance: [observed(buildA), observed(buildB)] },
    { id: 2, screenName: "Other", visitCount: 1, provenance: [observed(buildB)] },
  ],
  edges: [
    {
      id: 1,
      from: "Home",
      to: "Other",
      toolName: "tapOn",
      traversalCount: 1,
      provenance: [observed(buildB)],
    },
  ],
};

// Only the four resource-provider interfaces' required members are needed here.
type GraphProvider = NonNullable<Parameters<typeof setNavigationGraphProvider>[0]>;
class BuildLensGraphProvider implements GraphProvider {
  requestedAppIds: Array<string | null> = [];

  async exportGraphSummary(): Promise<NavigationGraphSummary> {
    throw new Error("Unexpected unscoped graph export");
  }

  async exportGraphSummaryForApp(appId: string | null): Promise<NavigationGraphSummary> {
    this.requestedAppIds.push(appId);
    return summary;
  }

  async getNodeResourceById(): Promise<null> {
    return null;
  }

  async getNodeResourceByScreen(): Promise<null> {
    return null;
  }

  async exportGraphHistory(): Promise<never> {
    throw new Error("Unexpected history export");
  }

  async listAppsWithGraph(): Promise<[]> {
    return [];
  }
}

const readResourceResponseSchema = z.object({
  contents: z.array(
    z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string().optional() }),
  ),
});

describe("MCP navigation build lens resources", () => {
  let fixture: McpTestFixture;
  let provider: BuildLensGraphProvider;
  let restoreHermeticServer: () => void;

  beforeAll(async () => {
    restoreHermeticServer = installHermeticServerFixture();
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  beforeEach(() => {
    provider = new BuildLensGraphProvider();
    setNavigationGraphProvider(provider);
  });

  afterEach(() => {
    setNavigationGraphProvider(null);
  });

  afterAll(async () => {
    await fixture.teardown();
    restoreHermeticServer();
  });

  async function read(uri: string): Promise<string> {
    const { client } = fixture.getContext();
    const result = await client.request(
      { method: "resources/read", params: { uri } },
      readResourceResponseSchema,
    );
    expect(result.contents[0]?.uri).toBe(uri);
    expect(result.contents[0]?.mimeType).toBe("application/json");
    return result.contents[0]?.text ?? "";
  }

  test("build filter annotates the app-scoped union graph", async () => {
    const uri =
      "automobile:navigation/graph/build-filter?appId=com.example.app&versionCode=1&contentHash=a";
    const graph: NavigationBuildFilterResourceContent = JSON.parse(await read(uri));
    expect(graph.buildKey).toEqual(buildA);
    expect(graph.currentScreen).toBe("Home");
    expect(graph.nodes.map((node) => node.inFilterBuild)).toEqual([true, false]);
    expect(graph.edges.map((edge) => [edge.inFilterBuild, edge.unverifiedForFilterBuild])).toEqual([
      [false, true],
    ]);
    expect(provider.requestedAppIds).toEqual(["com.example.app"]);
  });

  test("build diff reports both and only-B presence", async () => {
    const uri =
      "automobile:navigation/graph/build-diff?appId=com.example.app&versionCodeA=1&contentHashA=a&versionCodeB=2&contentHashB=b";
    const graph: NavigationBuildDiffResourceContent = JSON.parse(await read(uri));
    expect(graph.buildA).toEqual(buildA);
    expect(graph.buildB).toEqual(buildB);
    expect(graph.nodes.map((node) => node.presence)).toEqual(["both", "onlyB"]);
    expect(graph.edges.map((edge) => edge.presence)).toEqual(["onlyB"]);
    expect(provider.requestedAppIds).toEqual(["com.example.app"]);
  });

  test("blank appId returns a JSON error envelope", async () => {
    const uri = "automobile:navigation/graph/build-filter?appId=%20&versionCode=1&contentHash=a";
    const body: { error: string } = JSON.parse(await read(uri));
    expect(body.error).toContain("App ID is required");
    expect(provider.requestedAppIds).toEqual([]);
  });

  test("handler rejects absent appId and defaults an absent content hash", async () => {
    const template = ResourceRegistry.getTemplate(NAVIGATION_RESOURCE_URIS.GRAPH_BUILD_FILTER);
    if (!template || !("handler" in template)) {
      throw new Error("Build filter resource template is not registered");
    }
    const missingApp = await template.handler({ versionCode: "1", contentHash: "a" });
    const errorBody: { error: string } = JSON.parse(missingApp.text ?? "");
    expect(errorBody.error).toContain("App ID is required");

    const withoutHash = await template.handler({ appId: "com.example.app", versionCode: "1" });
    const graph: NavigationBuildFilterResourceContent = JSON.parse(withoutHash.text ?? "");
    expect(graph.buildKey.contentHash).toBe("");
  });

  test("invalid versionCode returns a JSON error envelope", async () => {
    const uri =
      "automobile:navigation/graph/build-diff?appId=com.example.app&versionCodeA=oops&contentHashA=a&versionCodeB=2&contentHashB=b";
    const body: { error: string } = JSON.parse(await read(uri));
    expect(body.error).toContain("Invalid versionCodeA");
    expect(provider.requestedAppIds).toEqual([]);
  });

  test("registers both build lens templates", async () => {
    const { client } = fixture.getContext();
    const result = await client.request(
      { method: "resources/templates/list", params: {} },
      z.object({ resourceTemplates: z.array(z.object({ uriTemplate: z.string() })) }),
    );
    const uris = result.resourceTemplates.map((template) => template.uriTemplate);
    expect(uris).toContain(NAVIGATION_RESOURCE_URIS.GRAPH_BUILD_FILTER);
    expect(uris).toContain(NAVIGATION_RESOURCE_URIS.GRAPH_BUILD_DIFF);
  });
});
