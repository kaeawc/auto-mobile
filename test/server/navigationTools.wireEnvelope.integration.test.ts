import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { Explore } from "../../src/features/navigation/Explore";
import type {
  ExploreDryRunResult,
  ExploreResult,
} from "../../src/features/navigation/ExploreTypes";
import type { BootedDevice } from "../../src/models";
import type { NavigateToResult } from "../../src/models/NavigateToResult";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { isToolResponseFailure } from "../../src/server/pipeline/afterToolCall";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { ExportedGraph } from "../../src/utils/interfaces/NavigationGraph";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

/**
 * Pins the exact serialized CallTool result for the navigation tools (navigateTo,
 * getNavigationGraph, explore) as it leaves the server transport (#11830). The real
 * registered handlers run against fakes; the MCP boundary, the client's outputSchema
 * validation and the finalizer are production code. An envelope change that alters a
 * single wire byte, or a payload the declared outputSchema rejects, fails here.
 */
const device: BootedDevice = { name: "fake", deviceId: "fake-11830", platform: "android" };

isolateToolRegistry();

let navigateResult: NavigateToResult;
const graph = new FakeNavigationGraphManager();

const exportedGraph: ExportedGraph = {
  appId: "com.example",
  nodes: [{ screenName: "Home", firstSeenAt: 0, lastSeenAt: 1_000, visitCount: 2 }],
  edges: [
    {
      from: "Home",
      to: "Settings",
      timestamp: 500,
      edgeType: "tool",
      interaction: { toolName: "tapOn", args: { text: "Settings" }, timestamp: 400 },
      uiState: { selectedElements: [{ text: "Home" }] },
    },
  ],
  currentScreen: "Home",
};

const exploreResult: ExploreResult = {
  success: true,
  cancelled: false,
  interactionsPerformed: 1,
  screensDiscovered: 1,
  edgesAdded: 1,
  navigationGraph: exportedGraph,
  explorationPath: ["Home", "Settings"],
  coverage: { totalScreens: 2, exploredScreens: 2, percentage: 100 },
  elementSelections: [],
  durationMs: 10,
  stopReason: "Reached max interactions",
};

const dryRunResult: ExploreDryRunResult = {
  success: true,
  dryRun: true,
  currentScreen: { name: "Home", interactableElements: 1 },
  plannedInteractions: [
    {
      order: 1,
      action: "tapOn",
      target: { type: "text", value: "Settings" },
      reason: "unexplored",
      predictedOutcome: { screen: "Settings", confidence: 0.9 },
      whitelistStatus: "allowed",
    },
  ],
  estimatedCoverage: {
    screensToVisit: ["Settings"],
    newScreensExpected: 0,
    existingScreensToRevisit: 1,
  },
  warnings: [],
  durationMs: 3,
};

describe("navigationTools structured wire envelopes", () => {
  let fixture: McpTestFixture;
  let restoreHermetic: () => void;
  const wire: string[] = [];

  beforeAll(async () => {
    restoreHermetic = installHermeticServerFixture();
    serverConfig.setEmbeddedSdkEnabled(true);
    fixture = new McpTestFixture({
      sessionToolSelectionService: {
        isEnabled: async () => true,
        getOverride: async () => undefined,
        setEnabled: async () => {},
        deleteSession: async () => {},
      },
    });
    await fixture.setup();
    registerNavigationTools({
      navigationManagerFactory: () => graph,
      navigateToFactory: () => ({ execute: async () => navigateResult }),
    });
    // Caches the advertised outputSchemas, so the client validates every structuredContent.
    await fixture.client.listTools();
    const transport = fixture.serverTransport as { send(message: JSONRPCMessage): Promise<void> };
    const send = transport.send.bind(transport);
    transport.send = async (message: JSONRPCMessage) => {
      if ("result" in message) {
        wire.push(JSON.stringify(message.result));
      }
      return send(message);
    };
  });

  afterAll(async () => {
    await fixture.teardown();
    serverConfig.setEmbeddedSdkEnabled(false);
    restoreHermetic();
  });

  afterEach(() => {
    wire.length = 0;
  });

  /** Returns the serialized wire result and the pipeline's failure verdict on the handler result. */
  async function callOnWire(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ wire: string; failure: boolean }> {
    const tool = ToolRegistry.getRegisteredTool(name)!;
    let failure: boolean | undefined;
    const handlerSpy = spyOn(tool, "handler").mockImplementation(async () => {
      const response = await tool.deviceAwareHandler!(device, args);
      failure = isToolResponseFailure(response);
      return finalizeToolResponse(response, {
        name,
        outputSchema: tool.outputSchema,
        artifactWriter: new FakeArtifactWriter(),
      });
    });
    try {
      wire.length = 0;
      await fixture.client.callTool({ name, arguments: args });
      expect(wire).toHaveLength(1);
      return { wire: wire[0], failure: failure! };
    } finally {
      handlerSpy.mockRestore();
    }
  }

  /** The main-branch schemaless wire: the payload serialized once as the only text part. */
  const textWire = (payload: Record<string, unknown>, tail: Record<string, unknown> = {}) =>
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }], ...tail });

  test("navigateTo success", async () => {
    navigateResult = {
      success: true,
      message: 'Successfully navigated to "Settings"',
      currentScreen: "Settings",
      targetScreen: "Settings",
      stepsExecuted: 1,
      path: ["tapOn"],
      durationMs: 5,
    };
    expect(await callOnWire("navigateTo", { targetScreen: "Settings" })).toEqual({
      failure: false,
      wire: textWire({
        message: 'Successfully navigated to "Settings"',
        success: true,
        currentScreen: "Settings",
        targetScreen: "Settings",
        stepsExecuted: 1,
        path: ["tapOn"],
        durationMs: 5,
      }),
    });
  });

  test("navigateTo failure", async () => {
    navigateResult = {
      success: false,
      error: "Navigation timeout (30 seconds)",
      currentScreen: "Home",
      targetScreen: "Settings",
      stepsExecuted: 0,
      partialPath: [],
      durationMs: 5,
    };
    expect(await callOnWire("navigateTo", { targetScreen: "Settings" })).toEqual({
      failure: true,
      wire: textWire(
        {
          error: "Navigation timeout (30 seconds)",
          success: false,
          currentScreen: "Home",
          targetScreen: "Settings",
          stepsExecuted: 0,
          partialPath: [],
          durationMs: 5,
        },
        { isError: true },
      ),
    });
  });

  test("getNavigationGraph", async () => {
    const stats = spyOn(graph, "getStatsForApp").mockResolvedValue({
      nodeCount: 1,
      edgeCount: 1,
      currentScreen: "Home",
      knownEdgeCount: 1,
      unknownEdgeCount: 0,
      toolCallHistorySize: 3,
    });
    const exported = spyOn(graph, "exportGraphForApp").mockResolvedValue(exportedGraph);
    try {
      expect(await callOnWire("getNavigationGraph", { appId: "com.example" })).toEqual({
        failure: false,
        wire: textWire({
          message: "Navigation graph for app: com.example",
          requestedAppId: "com.example",
          observedAppId: null,
          currentScreen: "Home",
          nodeCount: 1,
          edgeCount: 1,
          knownEdges: 1,
          unknownEdges: 0,
          screens: [{ name: "Home", visitCount: 2, lastVisited: "1970-01-01T00:00:01.000Z" }],
          transitions: [
            {
              from: "Home",
              to: "Settings",
              type: "tool",
              tool: "tapOn",
              args: { text: "Settings" },
              uiState: { selectedElements: [{ text: "Home" }] },
            },
          ],
        }),
      });
    } finally {
      stats.mockRestore();
      exported.mockRestore();
    }
  });

  const completedMessage =
    "Exploration completed: 1 interactions, 1 new screens discovered, 100% coverage";
  test.each([
    ["completed", exploreResult, false, textWire({ message: completedMessage, ...exploreResult })],
    [
      "failed",
      { ...exploreResult, success: false, error: "explore failed" },
      true,
      textWire({
        message: completedMessage,
        ...exploreResult,
        success: false,
        error: "explore failed",
      }),
    ],
    [
      "dry run",
      dryRunResult,
      false,
      textWire({
        message: "Exploration dry run completed: 1 planned interactions",
        ...dryRunResult,
      }),
    ],
  ] as const)("explore %s", async (_label, result, failure, expected) => {
    const execute = spyOn(Explore.prototype, "execute").mockResolvedValue(result);
    try {
      expect(await callOnWire("explore", { maxInteractions: 1 })).toEqual({
        failure,
        wire: expected,
      });
    } finally {
      execute.mockRestore();
    }
  });
});
