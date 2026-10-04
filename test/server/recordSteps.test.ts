import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createMcpServer } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  getMcpRecorder,
  resetMcpRecordingState,
  startMcpRecording,
} from "../../src/server/mcpRecordingManager";
import { serverConfig } from "../../src/utils/ServerConfig";
import { getStructuredField } from "../../src/utils/toolUtils";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { FakeTimer } from "../fakes/FakeTimer";

// Exercise plain registered handlers and the existing protocol onclose hook
// directly: no live transport, SDK request timers, device, or database needed.
describe("recordSteps connection scope and direct transport teardown", () => {
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
    originallyEnabled = serverConfig.isMcpRecordingEnabled();
    direct = createMcpServer({ sessionContext: { sessionId: "direct-A" } });
    loopback = createMcpServer({ daemonMode: true, sessionContext: { sessionId: "loopback" } });
  });

  afterEach(() => {
    resetMcpRecordingState();
    serverConfig.setMcpRecordingEnabled(originallyEnabled);
  });

  afterAll(() => {
    direct.server.onclose?.();
    loopback.server.onclose?.();
    initializeSpy.mockRestore();
    clockSpy.mockRestore();
    restoreHermeticServer();
  });

  test("recordSteps begin, status, and end use the injected connection identity", async () => {
    serverConfig.setMcpRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordSteps")!;
    // executeToolCall validates public args first, then injects internal params.
    const publicBegin = tool.schema.parse({ action: "begin" });
    const a = await tool.handler({ ...publicBegin, __mcpSessionId: "A" });
    const b = await tool.handler({ ...publicBegin, __mcpSessionId: "B" });
    expect(getStructuredField(a, "success")).toBe(true);
    expect(getStructuredField(b, "alreadyActive")).toBeUndefined();
    getMcpRecorder({ connectionId: "A" })!.record("tapOn", { text: "Only A" });
    const statusB = await tool.handler({ action: "status", __mcpSessionId: "B" });
    expect(getStructuredField(statusB, "stepCount")).toBe(0);
    const endB = await tool.handler({ action: "end", __mcpSessionId: "B" });
    expect(getStructuredField(endB, "success")).toBe(false);
    const endA = await tool.handler({ action: "end", __mcpSessionId: "A" });
    expect(getStructuredField(endA, "success")).toBe(true);
    expect(getStructuredField(endA, "planContent")).toContain("Only A");
  });

  test("recordSteps end exports launchApp without transport metadata", async () => {
    serverConfig.setMcpRecordingEnabled(true);
    const tool = ToolRegistry.getTool("recordSteps")!;
    await tool.handler({ action: "begin", __mcpSessionId: "clean-export" });
    getMcpRecorder({ connectionId: "clean-export" })!.record("launchApp", {
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
    expect(getStructuredField(result, "success")).toBe(true);
    expect(getStructuredField(result, "planContent")).toContain("appId: com.android.settings");
    expect(getStructuredField(result, "planContent")).not.toContain("__");
  });

  test("direct onclose discards its recording and preserves other connections", () => {
    const timer = new FakeTimer();
    startMcpRecording({ connectionId: "direct-A", timer });
    startMcpRecording({ connectionId: "other", timer });
    direct.server.onclose?.();
    expect(getMcpRecorder({ connectionId: "direct-A" })).toBeNull();
    expect(getMcpRecorder({ connectionId: "other" })?.isRecording()).toBe(true);
  });

  test("loopback onclose preserves socket recordings until the direct owner closes", () => {
    const timer = new FakeTimer();
    startMcpRecording({ connectionId: "loopback", timer });
    startMcpRecording({ connectionId: "direct-A", timer });
    loopback.server.onclose?.();
    expect(getMcpRecorder({ connectionId: "loopback" })?.isRecording()).toBe(true);
    direct.server.onclose?.();
    expect(getMcpRecorder({ connectionId: "direct-A" })).toBeNull();
    expect(getMcpRecorder({ connectionId: "loopback" })?.isRecording()).toBe(true);
  });
});
