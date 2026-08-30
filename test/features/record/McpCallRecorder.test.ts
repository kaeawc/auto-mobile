import { expect, describe, test } from "bun:test";
import {
  McpCallRecorder,
  PLAN_RELEVANT_TOOLS,
  stripInternalParams,
} from "../../../src/features/record/McpCallRecorder";

describe("McpCallRecorder", () => {
  describe("recording lifecycle", () => {
    test("starts in non-recording state", () => {
      const recorder = new McpCallRecorder();
      expect(recorder.isRecording()).toBe(false);
      expect(recorder.stepCount).toBe(0);
    });

    test("start enables recording", () => {
      const recorder = new McpCallRecorder();
      recorder.start();
      expect(recorder.isRecording()).toBe(true);
    });

    test("stop returns recorded steps and disables recording", () => {
      const recorder = new McpCallRecorder();
      recorder.start();
      recorder.record("tapOn", { text: "Login" });
      recorder.record("inputText", { text: "user@test.com" });

      const steps = recorder.stop();
      expect(recorder.isRecording()).toBe(false);
      expect(steps).toHaveLength(2);
      expect(steps[0]).toEqual({ tool: "tapOn", params: { text: "Login" } });
      expect(steps[1]).toEqual({ tool: "inputText", params: { text: "user@test.com" } });
    });

    test("start clears previous steps", () => {
      const recorder = new McpCallRecorder();
      recorder.start();
      recorder.record("tapOn", { text: "Login" });
      expect(recorder.stepCount).toBe(1);

      recorder.start();
      expect(recorder.stepCount).toBe(0);
    });

    test("stop returns a copy, not a reference to internal state", () => {
      const recorder = new McpCallRecorder();
      recorder.start();
      recorder.record("tapOn", { text: "Login" });
      const steps = recorder.stop();

      expect(steps).toHaveLength(1);
      steps.push({ tool: "fake", params: {} });
      expect(steps).toHaveLength(2);

      expect(recorder.stepCount).toBe(0);
      expect(recorder.stop()).toEqual([]);
    });
  });

  describe("tool filtering", () => {
    test("records plan-relevant tools", () => {
      const recorder = new McpCallRecorder();
      recorder.start();

      recorder.record("launchApp", { appId: "com.test" });
      recorder.record("observe", {});
      recorder.record("tapOn", { text: "Login" });
      recorder.record("inputText", { text: "test" });
      recorder.record("pressButton", { button: "back" });
      recorder.record("swipeOn", { direction: "up" });
      recorder.record("terminateApp", { appId: "com.test" });

      expect(recorder.stepCount).toBe(7);
    });

    test("records crashApp with only reproducible plan parameters", () => {
      const recorder = new McpCallRecorder();
      recorder.start();

      recorder.record("crashApp", {
        appId: "com.test",
        platform: "android",
        deviceId: "emulator-5554",
      });

      expect(recorder.stop()).toEqual([{ tool: "crashApp", params: { appId: "com.test" } }]);
    });

    test("records clearText and dragAndDrop as plan steps", () => {
      const recorder = new McpCallRecorder();
      recorder.start();

      recorder.record("clearText", { id: "email" });
      recorder.record("dragAndDrop", { from: "source", to: "destination" });

      expect(recorder.stop()).toEqual([
        { tool: "clearText", params: { id: "email" } },
        { tool: "dragAndDrop", params: { from: "source", to: "destination" } },
      ]);
    });

    test("ignores infrastructure tools", () => {
      const recorder = new McpCallRecorder();
      recorder.start();

      recorder.record("listDevices", {});
      recorder.record("startDevice", { deviceName: "Pixel" });
      recorder.record("killDevice", { deviceId: "emulator-5554" });
      recorder.record("setActiveDevice", { deviceId: "emulator-5554" });
      recorder.record("installApp", { appPath: "/tmp/app.apk" });
      recorder.record("startTestRecording", {});
      recorder.record("exportPlan", {});
      recorder.record("executePlan", { plan: "test" });
      recorder.record("screenshot", {});

      expect(recorder.stepCount).toBe(0);
    });

    test("does not record when not in recording state", () => {
      const recorder = new McpCallRecorder();
      recorder.record("tapOn", { text: "Login" });
      expect(recorder.stepCount).toBe(0);
    });
  });

  describe("param stripping", () => {
    test("records only non-internal params", () => {
      const recorder = new McpCallRecorder();
      recorder.start();

      recorder.record("tapOn", {
        text: "Login",
        action: "tap",
        platform: "android",
        deviceId: "emulator-5554",
        sessionUuid: "abc-123",
        device: "A",
        devices: ["A", "B"],
        keepScreenAwake: true,
      });

      const steps = recorder.stop();
      expect(steps).toHaveLength(1);
      expect(steps[0].params).toEqual({ text: "Login", action: "tap" });
    });

    // Every routing param injected by ToolRegistry must be stripped from a
    // recorded step. The router-internal `__mcpSessionId` and `__lockNamespace`
    // had no coverage and would otherwise leak into exported plans.
    test.each([
      "platform",
      "deviceId",
      "sessionUuid",
      "device",
      "devices",
      "keepScreenAwake",
      "__mcpSessionId",
      "__lockNamespace",
      "__internalNoDiff",
    ])("strips the internal routing param %p from a recorded step", (internalParam) => {
      const recorder = new McpCallRecorder();
      recorder.start();

      recorder.record("tapOn", { text: "keep-me", [internalParam]: "leak" });

      const steps = recorder.stop();
      expect(steps).toHaveLength(1);
      expect(steps[0].params).toEqual({ text: "keep-me" });
    });

    test("preserves all non-internal params", () => {
      const recorder = new McpCallRecorder();
      recorder.start();

      recorder.record("tapOn", {
        text: "My Inbox",
        timeout: 10000,
        containerElementId: "com.test:id/container",
        platform: "android",
      });

      const steps = recorder.stop();
      expect(steps[0].params).toEqual({
        text: "My Inbox",
        timeout: 10000,
        containerElementId: "com.test:id/container",
      });
    });
  });
});

describe("stripInternalParams", () => {
  test("removes all internal params", () => {
    const result = stripInternalParams({
      text: "Hello",
      platform: "android",
      deviceId: "emulator-5554",
      sessionUuid: "uuid",
      device: "A",
      devices: ["A"],
      keepScreenAwake: true,
    });
    expect(result).toEqual({ text: "Hello" });
  });

  test("returns empty object when all params are internal", () => {
    const result = stripInternalParams({
      platform: "android",
      deviceId: "emulator-5554",
    });
    expect(result).toEqual({});
  });

  test("passes through args with no internal params unchanged", () => {
    const args = { text: "Login", action: "tap", elementId: "com.test:id/btn" };
    const result = stripInternalParams(args);
    expect(result).toEqual(args);
  });

  // Issue #3053: PlanExecutor marks internal tool-to-tool calls with
  // `__internalNoDiff` so their finalized envelope is never diffed/stripped. It is
  // an injected internal param and must not leak into recorded plan steps.
  test("strips the __internalNoDiff plan-step marker (#3053)", () => {
    const result = stripInternalParams({ text: "Go", __internalNoDiff: true });
    expect(result).toEqual({ text: "Go" });
  });
});

describe("PLAN_RELEVANT_TOOLS", () => {
  test("excludes infrastructure tools", () => {
    const excluded = [
      "listDevices",
      "startDevice",
      "killDevice",
      "setActiveDevice",
      "installApp",
      "startTestRecording",
      "exportPlan",
      "executePlan",
      "screenshot",
    ];
    for (const tool of excluded) {
      expect(PLAN_RELEVANT_TOOLS.has(tool)).toBe(false);
    }
  });
});
