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
import { getRemovedToolHint } from "../../src/utils/removedTools";
import {
  getToolCallRecorder,
  resetToolCallRecordingState,
  startToolCallRecording,
} from "../../src/daemon/toolCallRecordingManager";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { toolField, toolIsError, toolJson, toolStructured } from "../helpers/toolResponse";

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

  test("recordToolCalls begin, status, and end use the injected connection identity", async () => {
    serverConfig.setToolCallRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    // executeToolCall validates public args first, then injects internal params.
    const publicBegin = tool.schema.parse({ action: "begin" });
    const a = await tool.handler({ ...publicBegin, __mcpSessionId: "A" });
    const b = await tool.handler({ ...publicBegin, __mcpSessionId: "B" });
    expect(toolField(a, "success")).toBe(true);
    expect(toolField(b, "alreadyActive")).toBeUndefined();
    recordPlanCall(getToolCallRecorder({ connectionId: "A" })!, "tapOn", { text: "Only A" });
    const statusB = await tool.handler({ action: "status", __mcpSessionId: "B" });
    expect(toolField(statusB, "stepCount")).toBe(0);
    const endB = await tool.handler({ action: "end", __mcpSessionId: "B" });
    expect(toolField(endB, "success")).toBe(false);
    expect(toolIsError(endB)).toBe(true);
    expect(toolStructured(endB)).toEqual(toolJson(endB));
    const endA = await tool.handler({ action: "end", __mcpSessionId: "A" });
    expect(toolField(endA, "success")).toBe(true);
    expect(toolIsError(endA)).toBe(false);
    expect(toolField(endA, "planContent")).toContain("Only A");
  });

  test("disabled recording and ending without a recording are errors", async () => {
    const tool = ToolRegistry.getTool("recordToolCalls")!;
    serverConfig.setToolCallRecordingEnabled(false);
    for (const action of ["begin", "end"]) {
      const response = await tool.handler({ action });
      const payload = {
        success: false,
        error:
          "Tool call recording is disabled. Enable the 'tool-call-recording' feature flag first.",
      };
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
    await tool.handler({ action: "begin", __mcpSessionId: "clean-export" });
    recordPlanCall(getToolCallRecorder({ connectionId: "clean-export" })!, "launchApp", {
      appId: "com.android.settings",
      sessionUuid: "session",
      __mcpRequestTimeoutMs: 120000,
      __mcpRequestDeadlineMs: 1790948577851,
      __foo: "reserved",
    });
    const result = await tool.handler({
      action: "end",
      planName: "clean-launch",
      __mcpSessionId: "clean-export",
    });
    expect(toolField(result, "success")).toBe(true);
    expect(toolField(result, "planContent")).toContain("appId: com.android.settings");
    expect(toolField(result, "planContent")).not.toContain("__");
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
