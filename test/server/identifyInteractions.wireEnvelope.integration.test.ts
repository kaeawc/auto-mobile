import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { IdentifyInteractions } from "../../src/features/observe/IdentifyInteractions";
import type { BootedDevice } from "../../src/models";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { registerObserveTools } from "../../src/server/observeTools";
import { isToolResponseFailure } from "../../src/server/pipeline/afterToolCall";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

/**
 * Pins the exact serialized CallTool result for identifyInteractions as it leaves the
 * server transport (#11830), for a successful analysis and for the no-observation
 * failure: the text part, the retained `structuredContent` and the hoisted
 * `success`/`error`, plus the pipeline failure verdict on each handler result. The real registered
 * handler runs against fakes (the analyzer's verdict is stubbed); the MCP boundary, the
 * client's outputSchema validation and the finalizer are production code. An envelope
 * change that alters a single wire byte, or a payload the declared outputSchema rejects,
 * fails here.
 */
const device: BootedDevice = { name: "fake", deviceId: "fake-11830", platform: "android" };

isolateToolRegistry();

type AnalyzeResult = ReturnType<IdentifyInteractions["analyze"]>;

const identified: AnalyzeResult = {
  success: true,
  screenName: "Home",
  interactions: [
    {
      id: "interaction-1",
      type: "navigation",
      description: "Settings navigation",
      confidence: 0.9,
      suggestedToolCall: { tool: "tapOn", params: { text: "Settings", action: "tap" } },
      predictedOutcome: { type: "screen_change", destination: "Settings", confidence: 0.8 },
      element: {
        resourceId: "com.example:id/settings",
        text: "Settings",
        className: "android.widget.Button",
        bounds: { left: 0, top: 100, right: 200, bottom: 160 },
      },
    },
  ],
  summary: {
    totalInteractable: 1,
    byType: { navigation: 1 },
    navigationOptions: 1,
    inputFields: 0,
  },
};

const unobserved: AnalyzeResult = {
  success: false,
  screenName: "UnknownScreen",
  interactions: [],
  summary: { totalInteractable: 0, byType: {}, navigationOptions: 0, inputFields: 0 },
  error: "No observation available. Call the 'observe' tool first to capture screen state.",
};

describe("identifyInteractions wire envelopes", () => {
  let fixture: McpTestFixture;
  let restoreHermetic: () => void;
  let previousDebugMode = false;
  const wire: string[] = [];
  const screen = new FakeObserveScreen();

  beforeAll(async () => {
    restoreHermetic = installHermeticServerFixture();
    fixture = new McpTestFixture({
      sessionToolSelectionService: {
        isEnabled: async () => true,
        getOverride: async () => undefined,
        setEnabled: async () => {},
        deleteSession: async () => {},
      },
    });
    await fixture.setup();
    previousDebugMode = isDebugModeEnabled();
    registerObserveTools({
      timer: new FakeTimer(),
      createScreen: () => ({
        execute: screen.execute.bind(screen),
        executeDeviceRead: () => screen.execute(),
        captureScreenshot: screen.captureScreenshot.bind(screen),
        appendRawViewHierarchy: screen.appendRawViewHierarchy.bind(screen),
        getMostRecentCachedObserveResult: screen.getMostRecentCachedObserveResult.bind(screen),
      }),
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
    setDebugModeEnabled(previousDebugMode);
    restoreHermetic();
  });

  afterEach(() => {
    wire.length = 0;
  });

  /** Returns the serialized wire result and the pipeline's failure verdict on the handler result. */
  async function callOnWire(result: AnalyzeResult): Promise<{ wire: string; failure: boolean }> {
    const name = "identifyInteractions";
    const args = { includeContext: { navigationGraph: false } };
    const tool = ToolRegistry.getRegisteredTool(name)!;
    expect(tool.outputSchema).toBeDefined();
    let failure: boolean | undefined;
    const navigation = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      new FakeNavigationGraphManager(),
    );
    const analyze = spyOn(IdentifyInteractions.prototype, "analyze").mockReturnValue(result);
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
      // identifyInteractions is callable in debug mode only. The server's feature flags
      // initialize asynchronously after setup and re-apply the stored (disabled) debug
      // flag, so enable it right before each call.
      setDebugModeEnabled(true);
      await fixture.client.callTool({ name, arguments: args });
      expect(wire).toHaveLength(1);
      return { wire: wire[0], failure: failure! };
    } finally {
      handlerSpy.mockRestore();
      analyze.mockRestore();
      navigation.mockRestore();
    }
  }

  /**
   * The structured wire: the payload serialized once as the text part, the same payload
   * retained as `structuredContent`, then the hoisted `success`/`error`. A failure never
   * sets `isError`, as before the tool declared a schema.
   */
  const structuredWire = (payload: object, tail: Record<string, unknown>) =>
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      ...tail,
    });

  test("identified interactions", async () => {
    expect(await callOnWire(identified)).toEqual({
      failure: false,
      wire: structuredWire(identified, { success: true }),
    });
  });

  test("no observation", async () => {
    expect(await callOnWire(unobserved)).toEqual({
      failure: true,
      wire: structuredWire(unobserved, { success: false, error: unobserved.error }),
    });
  });
});
