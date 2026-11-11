import { z } from "zod/v4";
import { recordPlanCall } from "../helpers/recordPlanCall";
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
import { createMcpServer } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerPlanTools } from "../../src/server/planTools";
import { TOOL_CALL_RECORDING_DISABLED_ERROR } from "../../src/server/toolCallRecordingTools";
import { getRemovedToolHint } from "../../src/utils/removedTools";
import {
  getToolCallRecorder,
  resetToolCallRecordingState,
  startToolCallRecording,
} from "../../src/daemon/toolCallRecordingManager";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FEATURE_FLAG_DEFINITIONS } from "../../src/features/featureFlags/FeatureFlagDefinitions";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { featureFlagDisabledMessage } from "../../src/features/featureFlags/featureFlagDisabledMessage";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { toolField, toolIsError, toolJson, toolStructured } from "../helpers/toolResponse";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";

/** Run `fn` as a top-level call made for MCP connection `connectionId`, as ingress does. */
const asConnection = <T>(connectionId: string, fn: () => Promise<T>): Promise<T> =>
  runWithToolSelectionContext({ autolockMcpSessionId: connectionId }, fn);

isolateToolRegistry();

// Exercise plain registered handlers and the existing protocol onclose hook
// directly: no live transport, SDK request timers, device, or database needed.
describe("recordToolCalls connection scope and direct transport teardown", () => {
  let direct: ReturnType<typeof createMcpServer>;
  let loopback: ReturnType<typeof createMcpServer>;
  let restoreHermeticServer: () => void;
  let initializeSpy: ReturnType<typeof spyOn>;
  let clockSpy: ReturnType<typeof spyOn>;
  let originallyEnabled: boolean;

  beforeAll(() => {
    restoreHermeticServer = installHermeticServerFixture();
    const timer = new FakeTimer();
    clockSpy = spyOn(defaultTimer, "now").mockImplementation(() => timer.now());
    initializeSpy = spyOn(FeatureFlagService.prototype, "initialize").mockResolvedValue();
    originallyEnabled = serverConfig.isToolCallRecordingEnabled();
    direct = createMcpServer({ sessionContext: { sessionId: "direct-A" } });
    loopback = createMcpServer({ daemonMode: true, sessionContext: { sessionId: "loopback" } });
  });

  beforeEach(() => {
    // Recorder state is module-level; another file in the same process may have left some.
    resetToolCallRecordingState();
  });

  afterEach(() => {
    resetToolCallRecordingState();
    serverConfig.setToolCallRecordingEnabled(originallyEnabled);
  });

  afterAll(() => {
    direct.server.onclose?.();
    loopback.server.onclose?.();
    initializeSpy.mockRestore();
    clockSpy.mockRestore();
    restoreHermeticServer();
  });

  test("only recordToolCalls is registered, with the same plain read/control classification", () => {
    registerPlanTools();
    expect(ToolRegistry.getRegisteredTool("recordSteps")).toBeUndefined();
    const tool = ToolRegistry.getRegisteredTool("recordToolCalls");
    expect(tool).toBeDefined();
    expect(tool!.requiresDevice).toBe(false);
    expect(tool!.hidden).not.toBe(true);
    expect(tool!.defaultEnabled).toBe(false);
    expect(tool!.outputSchema).toBeDefined();
    const classify = tool!.deviceReadOnly;
    expect(typeof classify).toBe("function");
    if (typeof classify !== "function") {
      throw new Error("Expected a per-args read/control classifier");
    }
    expect(classify({ action: "status" })).toBe(true);
    expect(classify({ action: "begin" })).toBe(false);
    expect(classify({ action: "end" })).toBe(false);
    expect(getRemovedToolHint("recordSteps")).toContain("recordToolCalls");
  });

  test("recording is on by default so an MCP-only client can begin once the tool is enabled", () => {
    const flag = FEATURE_FLAG_DEFINITIONS.find(({ key }) => key === "tool-call-recording");
    expect(flag?.defaultValue).toBe(true);
    expect(TOOL_CALL_RECORDING_DISABLED_ERROR).toBe(
      featureFlagDisabledMessage("tool-call-recording", "recordToolCalls"),
    );
  });

  test("argument values are discoverable from the published schemas", () => {
    const fieldSchema = (toolName: string, field: string): z.ZodType => {
      const schema = ToolRegistry.getTool(toolName)!.schema;
      if (!(schema instanceof z.ZodObject)) {
        throw new Error(`${toolName} schema is not an object`);
      }
      return schema.shape[field];
    };
    const action = fieldSchema("recordToolCalls", "action");
    expect(action.description).toContain("begin starts");
    expect(action.description).toContain("end stops");
    expect(action.safeParse("start").success).toBe(false);
    const exportPlan = fieldSchema("exportPlan", "recordingId");
    expect(exportPlan.description).toContain("recordDeviceGestures");
    expect(exportPlan.description).toContain("recordToolCalls recording");
    expect(ToolRegistry.getTool("exportPlan")!.description).toContain("recordToolCalls");
    expect(fieldSchema("recordToolCalls", "planName").description).toContain("on begin");
  });

  test("recordToolCalls begin, status, and end use the injected connection identity", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    // executeToolCall validates public args first, then injects internal params.
    const publicBegin = tool.schema.parse({ action: "begin" });
    const a = await asConnection("A", () => tool.handler({ ...publicBegin }));
    const b = await asConnection("B", () => tool.handler({ ...publicBegin }));
    expect(toolField(a, "success")).toBe(true);
    expect(toolField(b, "alreadyActive")).toBeUndefined();
    recordPlanCall(getToolCallRecorder({ connectionId: "A" })!, "tapOn", { text: "Only A" });
    const statusB = await asConnection("B", () => tool.handler({ action: "status" }));
    expect(toolField(statusB, "stepCount")).toBe(0);
    const endB = await asConnection("B", () => tool.handler({ action: "end" }));
    expect(toolField(endB, "success")).toBe(false);
    expect(toolIsError(endB)).toBe(true);
    expect(toolStructured(endB)).toEqual(toolJson(endB));
    const endA = await asConnection("A", () => tool.handler({ action: "end" }));
    expect(toolField(endA, "success")).toBe(true);
    expect(toolIsError(endA)).toBe(false);
    expect(toolField(endA, "planContent")).toContain("Only A");
  });

  test("one-shot CLI begin refuses before starting a recording", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    const response = await runWithToolSelectionContext(
      { oneShotCli: true, autolockMcpSessionId: "one-shot" },
      () => tool.handler(tool.schema.parse({ action: "begin", planName: "wear-accept-16830" })),
    );
    expect(toolField(response, "success")).toBe(false);
    expect(toolField(response, "action")).toBe("begin");
    expect(toolField(response, "error")).toContain("one-shot CLI call cannot hold a recording");
    expect(toolField(response, "error")).toContain("persistent MCP connection");
    expect(toolField(response, "error")).toContain("proxy / daemon MCP session");
    expect(toolField(response, "error")).toContain("Recordings are scoped to the MCP connection");
    expect(toolIsError(response)).toBe(true);
    expect(toolStructured(response)).toEqual(toolJson(response));
    expect(getToolCallRecorder({ connectionId: "one-shot" })).toBeNull();
    expect(getToolCallRecorder()).toBeNull();
  });

  test("persistent MCP begin still starts and records on its connection", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    const response = await asConnection("persistent", () =>
      tool.handler({ action: "begin", planName: "wear-accept-16830" }),
    );
    expect(toolIsError(response)).toBe(false);
    expect(toolStructured(response)).toEqual({
      success: true,
      action: "begin",
      recording: true,
      startedAt: new Date(defaultTimer.now()).toISOString(),
      planName: "wear-accept-16830",
    });
    expect(getToolCallRecorder({ connectionId: "persistent" })?.isRecording()).toBe(true);
    expect(getToolCallRecorder()).toBeNull();
  });

  test("one-shot CLI status and end keep their connection-scoped responses", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    await asConnection("persistent", () => tool.handler({ action: "begin" }));
    await runWithToolSelectionContext(
      { oneShotCli: true, autolockMcpSessionId: "one-shot" },
      async () => {
        const status = await tool.handler({ action: "status" });
        expect(toolIsError(status)).toBe(false);
        expect(toolStructured(status)).toEqual({
          success: true,
          action: "status",
          recording: false,
        });
        const end = await tool.handler({ action: "end" });
        expect(toolIsError(end)).toBe(true);
        expect(toolStructured(end)).toEqual({
          success: false,
          action: "end",
          error:
            "No active tool call recording on this MCP connection. " +
            'Call recordToolCalls with action: "begin" first. ' +
            "Recordings are scoped to the MCP connection that began them, so a separate " +
            "connection (such as a one-shot CLI call) cannot end another connection's recording.",
        });
        expect(toolStructured(end)).toEqual(toolJson(end));
      },
    );
    expect(getToolCallRecorder({ connectionId: "persistent" })?.isRecording()).toBe(true);
  });

  test("disabled recording and ending without a recording are errors", async () => {
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    serverConfig.setToolCallRecordingEnabled(false);
    for (const action of ["begin", "end"]) {
      const response = await tool.handler({ action });
      const payload = { success: false, error: TOOL_CALL_RECORDING_DISABLED_ERROR };
      expect(toolIsError(response)).toBe(true);
      expect(toolStructured(response)).toEqual(payload);
      expect(toolJson(response)).toEqual(payload);
    }
    serverConfig.setToolCallRecordingEnabled(true);
    const response = await tool.handler({ action: "end" });
    expect(toolIsError(response)).toBe(true);
    expect(toolField(response, "success")).toBe(false);
    expect(toolStructured(response)).toEqual(toolJson(response));
  });

  test("a caught begin failure marks the original payload", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    clockSpy.mockImplementationOnce(() => {
      throw new Error("Fake recorder clock failure");
    });
    const response = await ToolRegistry.getTool("recordToolCalls")!.handler({ action: "begin" });
    const payload = { success: false, action: "begin", error: "Fake recorder clock failure" };
    expect(toolIsError(response)).toBe(true);
    expect(toolStructured(response)).toEqual(payload);
    expect(toolJson(response)).toEqual(payload);
  });

  test("inactive status and already-active begin remain successful", async () => {
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    serverConfig.setToolCallRecordingEnabled(false);
    const status = await tool.handler({ action: "status" });
    expect(toolIsError(status)).toBe(false);
    expect(toolStructured(status)).toEqual({ success: true, action: "status", recording: false });
    serverConfig.setToolCallRecordingEnabled(true);
    const first = await tool.handler({ action: "begin" });
    const second = await tool.handler({ action: "begin" });
    expect(toolIsError(first)).toBe(false);
    expect(toolIsError(second)).toBe(false);
    expect(toolField(second, "success")).toBe(true);
    expect(toolField(second, "alreadyActive")).toBe(true);
    expect(toolStructured(second)).toEqual(toolJson(second));
  });

  test("recordToolCalls end exports launchApp without transport metadata", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    await asConnection("clean-export", () => tool.handler({ action: "begin" }));
    recordPlanCall(getToolCallRecorder({ connectionId: "clean-export" })!, "launchApp", {
      appId: "com.android.settings",
      sessionUuid: "session",
      __mcpRequestTimeoutMs: 120000,
      __mcpRequestDeadlineMs: 1790948577851,
      __foo: "reserved",
    });
    const result = await asConnection("clean-export", () =>
      tool.handler({ action: "end", planName: "clean-launch" }),
    );
    expect(toolField(result, "success")).toBe(true);
    expect(toolField(result, "planContent")).toContain("appId: com.android.settings");
    expect(toolField(result, "planContent")).not.toContain("__");
  });

  // Fixtures from #17950: begin {"planName":"dogfood-notes"} then end exported
  // "mcp-recorded-plan-2026-11-11T14-53-07-554Z", and exportPlan after begin returned
  // {"success":false,"error":"No active recording. Start a recording before exporting."}.
  const IGNORED_NAME = "mcp-recorded-plan-2026-11-11T14-53-07-554Z";
  const UNSEEN_RECORDING = {
    success: false,
    error: "No active recording. Start a recording before exporting.",
  };

  test("the begin planName names the plan end exports", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    const begin = await asConnection("named", () =>
      tool.handler(tool.schema.parse({ action: "begin", planName: "dogfood-notes" })),
    );
    expect(toolField(begin, "planName")).toBe("dogfood-notes");
    recordPlanCall(getToolCallRecorder({ connectionId: "named" })!, "tapOn", { text: "Save" });
    const end = await asConnection("named", () => tool.handler({ action: "end" }));
    expect(toolField(end, "planName")).toBe("dogfood-notes");
    expect(toolField(end, "planName")).not.toBe(IGNORED_NAME);
    expect(String(toolField(end, "planContent"))).toStartWith("name: dogfood-notes\n");
  });

  test("an end planName overrides the begin planName", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    await asConnection("renamed", () =>
      tool.handler({ action: "begin", planName: "dogfood-notes" }),
    );
    recordPlanCall(getToolCallRecorder({ connectionId: "renamed" })!, "tapOn", { text: "Save" });
    const end = await asConnection("renamed", () =>
      tool.handler({ action: "end", planName: "  final-name " }),
    );
    expect(toolField(end, "planName")).toBe("final-name");
  });

  test("exportPlan stops and exports this connection's recordToolCalls recording", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    const record = ToolRegistry.getTool("recordToolCalls")!;
    const exportPlan = ToolRegistry.getTool("exportPlan")!;
    await asConnection("export", () => record.handler({ action: "begin" }));
    recordPlanCall(getToolCallRecorder({ connectionId: "export" })!, "tapOn", { text: "Save" });
    const other = await asConnection("elsewhere", () =>
      exportPlan.handler({ planName: "dogfood-notes" }),
    );
    expect(toolIsError(other)).toBe(true);
    expect(toolField(other, "error")).toContain("recordToolCalls");
    const response = await asConnection("export", () =>
      exportPlan.handler({ planName: "dogfood-notes" }),
    );
    expect(toolStructured(response)).not.toEqual(UNSEEN_RECORDING);
    expect(toolIsError(response)).toBe(false);
    expect(toolStructured(response)).toEqual(toolJson(response));
    expect(toolField(response, "planName")).toBe("dogfood-notes");
    expect(toolField(response, "stepCount")).toBe(1);
    expect(String(toolField(response, "planContent"))).toContain("text: Save");
    expect(getToolCallRecorder({ connectionId: "export" })).toBeNull();
  });

  test("exportPlan with a recordingId leaves the recordToolCalls recording running", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    await asConnection("by-id", () =>
      ToolRegistry.getTool("recordToolCalls")!.handler({ action: "begin" }),
    );
    const response = await asConnection("by-id", () =>
      ToolRegistry.getTool("exportPlan")!.handler({ recordingId: "rec-unknown" }),
    );
    expect(toolIsError(response)).toBe(true);
    expect(getToolCallRecorder({ connectionId: "by-id" })?.isRecording()).toBe(true);
  });

  test("direct onclose discards its recording and preserves other connections", () => {
    const timer = new FakeTimer();
    startToolCallRecording({ connectionId: "direct-A", timer });
    startToolCallRecording({ connectionId: "other", timer });
    direct.server.onclose?.();
    expect(getToolCallRecorder({ connectionId: "direct-A" })).toBeNull();
    expect(getToolCallRecorder({ connectionId: "other" })?.isRecording()).toBe(true);
  });

  test("loopback onclose preserves socket recordings until the direct owner closes", () => {
    const timer = new FakeTimer();
    startToolCallRecording({ connectionId: "loopback", timer });
    startToolCallRecording({ connectionId: "direct-A", timer });
    loopback.server.onclose?.();
    expect(getToolCallRecorder({ connectionId: "loopback" })?.isRecording()).toBe(true);
    direct.server.onclose?.();
    expect(getToolCallRecorder({ connectionId: "direct-A" })).toBeNull();
    expect(getToolCallRecorder({ connectionId: "loopback" })?.isRecording()).toBe(true);
  });
});
