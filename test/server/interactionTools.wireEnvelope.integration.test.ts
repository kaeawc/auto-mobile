import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { HomeScreen } from "../../src/features/action/HomeScreen";
import { SystemTray } from "../../src/features/systemTray/SystemTray";
import type {
  BootedDevice,
  ClipboardResult,
  DragAndDropResult,
  PinchOnResult,
  RecentAppsResult,
  SelectAllTextResult,
  ShakeResult,
} from "../../src/models";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { isToolResponseFailure } from "../../src/server/pipeline/afterToolCall";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { getStructuredField, getStructuredPayload } from "../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

/**
 * Pins the exact serialized CallTool result for the schema'd interaction tools
 * selectAllText, pinchOn, dragAndDrop, shake, recentApps, homeScreen, clipboard and
 * systemTray as it leaves the server transport (#11830): the text part, the retained
 * `structuredContent`, the hoisted `success`/`error`, and `isError` only on a failure.
 * The real registered handlers run against fakes; the MCP boundary, the client's
 * outputSchema validation and the finalizer are production code. An envelope change
 * that alters a single wire byte, or a payload the declared outputSchema rejects, fails here.
 */
const device: BootedDevice = { name: "fake", deviceId: "fake-11830", platform: "android" };

isolateToolRegistry();

let selectAllTextResult: SelectAllTextResult;
let pinchOnResult: PinchOnResult;
let dragAndDropResult: DragAndDropResult;
let shakeResult: ShakeResult;
let recentAppsResult: RecentAppsResult;
let clipboardResult: ClipboardResult;

const pinched: PinchOnResult = {
  success: true,
  direction: "out",
  distanceStart: 100,
  distanceEnd: 300,
  duration: 300,
  centerX: 540,
  centerY: 960,
  targetType: "screen",
};

const dragged: DragAndDropResult = { success: true, duration: 600, distance: 420 };

describe("interaction tools wire envelopes", () => {
  let fixture: McpTestFixture;
  let restoreHermetic: () => void;
  const wire: string[] = [];

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
    registerInteractionTools({
      selectAllTextFactory: () => ({ execute: async () => selectAllTextResult }),
      pinchOnFactory: () => ({ execute: async () => pinchOnResult }),
      dragAndDropFactory: () => ({ execute: async () => dragAndDropResult }),
      shakeFactory: () => ({ execute: async () => shakeResult }),
      recentAppsFactory: () => ({ execute: async () => recentAppsResult }),
      clipboardFactory: () => ({ execute: async () => clipboardResult }),
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
    expect(tool.outputSchema).toBeDefined();
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

  /**
   * The structured wire: the payload serialized once as the text part, the same payload
   * retained as `structuredContent`, then the envelope tail (`isError` on a failure and the
   * hoisted `success`/`error`, in the order the transport emits them).
   */
  const structuredWire = (payload: Record<string, unknown>, outcome: "ok" | "failed" = "ok") =>
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      ...(outcome === "failed" ? { isError: true } : {}),
      success: payload.success,
      ...("error" in payload ? { error: payload.error } : {}),
    });

  const failed = "failed";

  test.each([
    [
      "success",
      { success: true },
      false,
      structuredWire({ message: "Selected all text in focused input field", success: true }),
    ],
    [
      "failure",
      { success: false, error: "No focused field" },
      true,
      structuredWire(
        {
          message: "Failed to select all text: No focused field",
          success: false,
          error: "No focused field",
        },
        failed,
      ),
    ],
  ] as const)("selectAllText %s", async (_label, result, failure, expected) => {
    selectAllTextResult = result;
    expect(await callOnWire("selectAllText", {})).toEqual({ failure, wire: expected });
  });

  test.each([
    ["success", pinched, false, structuredWire({ message: "Pinched out", ...pinched })],
    [
      "failure",
      { ...pinched, success: false, error: "scale must be positive" },
      true,
      structuredWire(
        {
          message: "scale must be positive",
          ...pinched,
          success: false,
          error: "scale must be positive",
        },
        failed,
      ),
    ],
  ] as const)("pinchOn %s", async (_label, result, failure, expected) => {
    pinchOnResult = result;
    expect(await callOnWire("pinchOn", { direction: "out" })).toEqual({
      failure,
      wire: expected,
    });
  });

  test.each([
    [
      "success",
      dragged,
      false,
      structuredWire({ message: "Dragged element to target", ...dragged }),
    ],
    [
      "failure",
      { success: false, duration: 0, distance: 0, error: "Source not found" },
      true,
      structuredWire(
        {
          message: "Failed to drag element to target: Source not found",
          success: false,
          duration: 0,
          distance: 0,
          error: "Source not found",
        },
        failed,
      ),
    ],
  ] as const)("dragAndDrop %s", async (_label, result, failure, expected) => {
    dragAndDropResult = result;
    expect(
      await callOnWire("dragAndDrop", { source: { text: "A" }, target: { text: "B" } }),
    ).toEqual({ failure, wire: expected });
  });

  test.each([
    [
      "success",
      { success: true, duration: 500, intensity: 50 },
      false,
      structuredWire({
        message: "Shook device for 500ms with intensity 50",
        success: true,
        duration: 500,
        intensity: 50,
      }),
    ],
    [
      "failure",
      { success: false, duration: 500, intensity: 50, error: "physical device" },
      true,
      structuredWire(
        {
          message: "Failed to shake device: physical device",
          success: false,
          duration: 500,
          intensity: 50,
          error: "physical device",
        },
        failed,
      ),
    ],
  ] as const)("shake %s", async (_label, result, failure, expected) => {
    shakeResult = result;
    expect(await callOnWire("shake", { duration: 500, intensity: 50 })).toEqual({
      failure,
      wire: expected,
    });
  });

  test.each([
    [
      "success",
      { success: true, method: "hardware" },
      false,
      structuredWire({ message: "Opened recent apps", success: true, method: "hardware" }),
    ],
    [
      "failure",
      { success: false, method: "ios_swipe", error: "runner down" },
      true,
      structuredWire(
        {
          message: "Failed to open recent apps: runner down",
          success: false,
          method: "ios_swipe",
          error: "runner down",
        },
        failed,
      ),
    ],
  ] as const)("recentApps %s", async (_label, result, failure, expected) => {
    recentAppsResult = result;
    expect(await callOnWire("recentApps", {})).toEqual({ failure, wire: expected });
  });

  test.each([
    [
      "success",
      { success: true, navigationMethod: "hardware" },
      false,
      structuredWire({
        message: "Pressed home button to return to the home screen",
        success: true,
        navigationMethod: "hardware",
      }),
    ],
    [
      "failure",
      { success: false, error: "Runner failed to press Home" },
      true,
      structuredWire(
        {
          message: "Pressed home button to return to the home screen",
          success: false,
          error: "Runner failed to press Home",
        },
        failed,
      ),
    ],
  ] as const)("homeScreen %s", async (_label, result, failure, expected) => {
    const execute = spyOn(HomeScreen.prototype, "execute").mockResolvedValue(result);
    try {
      expect(await callOnWire("homeScreen", {})).toEqual({ failure, wire: expected });
    } finally {
      execute.mockRestore();
    }
  });

  test.each([
    [
      "get",
      { success: true, action: "get", text: "hello", method: "a11y" },
      false,
      structuredWire({
        message: 'Retrieved clipboard content: "hello" (via a11y)',
        success: true,
        action: "get",
        text: "hello",
        method: "a11y",
      }),
    ],
    [
      "failure",
      { success: false, action: "paste", error: "No focused field" },
      true,
      structuredWire(
        {
          message: "Failed to execute clipboard paste: No focused field",
          success: false,
          action: "paste",
          error: "No focused field",
        },
        failed,
      ),
    ],
  ] as const)("clipboard %s", async (_label, result, failure, expected) => {
    clipboardResult = result;
    expect(await callOnWire("clipboard", { action: result.action })).toEqual({
      failure,
      wire: expected,
    });
  });

  const listed = {
    message: "Listed 1 notifications for com.example",
    notifications: [
      {
        id: "0|com.example|1",
        appId: "com.example",
        appLabel: "Example",
        title: "Hello",
        body: null,
        actions: [],
        texts: ["Hello"],
        inGroup: false,
        ownership: "header",
      },
    ],
    unattributedRows: 0,
    swipes: 0,
    order: "encounter",
    success: true,
  };
  const tapped = {
    message: "Tapped notification",
    settled: true,
    match: { title: { text: "Hello", matchType: "exact" } },
    tapTarget: {
      text: "Hello",
      matchType: "exact",
      bounds: { left: 0, top: 100, right: 1080, bottom: 200 },
    },
    success: true,
  };
  const uncleared = {
    dismissedCount: 1,
    expectedCount: 2,
    message:
      "Cleared 1 of 2 notification(s) for com.example; 1 remain after clearing. A matching notification may remain; dismissal was not confirmed or the swipe limit or deadline was reached.",
    remainingCount: 1,
    success: false,
    swipeCount: 3,
    stalled: true,
  };
  test.each([
    ["list", { action: "list", notification: { appId: "com.example" } }, listed, false],
    ["tap", { action: "tap", notification: { title: "Hello" } }, tapped, false],
    [
      "clearAll failure",
      { action: "clearAll", notification: { appId: "com.example" } },
      uncleared,
      true,
    ],
  ] as const)("systemTray %s", async (_label, args, payload, isError) => {
    const execute = spyOn(SystemTray.prototype, "execute").mockResolvedValue({ payload, isError });
    try {
      expect(await callOnWire("systemTray", args)).toEqual({
        failure: isError,
        wire: structuredWire(payload, isError ? failed : "ok"),
      });
    } finally {
      execute.mockRestore();
    }
  });

  // The finalizer renders a carried observation; the client validates the rendered
  // payload against the advertised schema and would reject the call on a mismatch.
  test("recentApps keeps a rendered observation schema-valid on the wire", async () => {
    recentAppsResult = {
      success: true,
      method: "hardware",
      observation: loadAndroidHomeObserve().observe,
    };
    const { wire: sent, failure } = await callOnWire("recentApps", {});
    const result = JSON.parse(sent) as {
      content: Array<{ type: "text"; text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(failure).toBe(false);
    expect(getStructuredField(result, "observation")).toBeDefined();
    expect(JSON.parse(result.content[0].text)).toEqual(getStructuredPayload(result));
  });
});
