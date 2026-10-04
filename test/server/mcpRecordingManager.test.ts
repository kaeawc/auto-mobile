import { expect, describe, test, beforeEach, spyOn } from "bun:test";
import {
  startMcpRecording,
  stopMcpRecording,
  getMcpRecordingStatus,
  getMcpRecorder,
  resetMcpRecordingState,
  dropMcpRecording,
} from "../../src/server/mcpRecordingManager";
import { PlanValidator } from "../../src/utils/plan/PlanValidator";
import { FakeTimer } from "../fakes/FakeTimer";

describe("mcpRecordingManager", () => {
  beforeEach(() => {
    resetMcpRecordingState();
  });

  describe("connection isolation", () => {
    test("two connections begin independently and only duplicate their own begin", () => {
      const timer = new FakeTimer();
      startMcpRecording({ connectionId: "A", timer });
      const second = startMcpRecording({ connectionId: "B", timer });
      expect(second.alreadyActive).toBeUndefined();
      expect(getMcpRecorder({ connectionId: "A" })).not.toBe(getMcpRecorder({ connectionId: "B" }));
      expect(startMcpRecording({ connectionId: "A", timer }).alreadyActive).toBe(true);
      expect(getMcpRecordingStatus({ connectionId: "C", timer })).toBeNull();
      expect(getMcpRecorder()).toBeNull();
    });

    test("ending one connection preserves the other's status and steps", () => {
      const timer = new FakeTimer();
      startMcpRecording({ connectionId: "A", timer });
      startMcpRecording({ connectionId: "B", timer });
      getMcpRecorder({ connectionId: "A" })!.record("tapOn", { text: "Only A" });
      getMcpRecorder({ connectionId: "B" })!.record("tapOn", { text: "Only B" });
      const a = stopMcpRecording({ connectionId: "A", timer });
      expect(a.planContent).toContain("Only A");
      expect(a.planContent).not.toContain("Only B");
      expect(getMcpRecordingStatus({ connectionId: "A", timer })).toBeNull();
      expect(getMcpRecordingStatus({ connectionId: "B", timer })).toMatchObject({
        recording: true,
        stepCount: 1,
      });
      const b = stopMcpRecording({ connectionId: "B", timer });
      expect(b.planContent).toContain("Only B");
      expect(b.planContent).not.toContain("Only A");
    });

    test("ending an absent connection cannot stop another recording", () => {
      const timer = new FakeTimer();
      startMcpRecording({ connectionId: "B", timer });
      getMcpRecorder({ connectionId: "B" })!.record("tapOn", { text: "Only B" });
      expect(() => stopMcpRecording({ connectionId: "A", timer })).toThrow(
        "No active MCP recording",
      );
      expect(getMcpRecordingStatus({ connectionId: "B", timer })?.stepCount).toBe(1);
    });

    test("an empty end clears only its connection", () => {
      const timer = new FakeTimer();
      startMcpRecording({ connectionId: "A", timer });
      startMcpRecording({ connectionId: "B", timer });
      getMcpRecorder({ connectionId: "B" })!.record("tapOn", { text: "Only B" });
      expect(() => stopMcpRecording({ connectionId: "A", timer })).toThrow(
        "No MCP tool calls were recorded",
      );
      expect(getMcpRecorder({ connectionId: "A" })).toBeNull();
      expect(getMcpRecordingStatus({ connectionId: "B", timer })?.stepCount).toBe(1);
      expect(stopMcpRecording({ connectionId: "B", timer }).stepCount).toBe(1);
    });

    test("a validation failure clears only its connection", () => {
      const timer = new FakeTimer();
      for (const connectionId of ["A", "B"]) {
        startMcpRecording({ connectionId, timer });
        getMcpRecorder({ connectionId })!.record("tapOn", { text: connectionId });
      }
      const spy = spyOn(PlanValidator, "validate").mockImplementation(() => {
        throw new Error("validation boom");
      });
      try {
        expect(() => stopMcpRecording({ connectionId: "A", timer })).toThrow("validation boom");
        expect(getMcpRecorder({ connectionId: "A" })).toBeNull();
        expect(getMcpRecordingStatus({ connectionId: "B", timer })).toMatchObject({
          recording: true,
          stepCount: 1,
        });
      } finally {
        spy.mockRestore();
      }
      expect(stopMcpRecording({ connectionId: "B", timer }).stepCount).toBe(1);
    });

    test("drop discards only its connection and is idempotent for absent ids", () => {
      const timer = new FakeTimer();
      startMcpRecording({ connectionId: "A", timer });
      startMcpRecording({ connectionId: "B", timer });
      const recorder = getMcpRecorder({ connectionId: "A" })!;
      dropMcpRecording("unknown");
      dropMcpRecording("A");
      dropMcpRecording("A");
      expect(getMcpRecordingStatus({ connectionId: "A", timer })).toBeNull();
      expect(getMcpRecorder({ connectionId: "A" })).toBeNull();
      expect(recorder.isRecording()).toBe(false);
      expect(getMcpRecorder({ connectionId: "B" })?.isRecording()).toBe(true);
    });

    test("anonymous calls share a default recording separate from named connections", () => {
      const timer = new FakeTimer();
      startMcpRecording({ timer });
      startMcpRecording({ connectionId: "A", timer });
      expect(startMcpRecording({ connectionId: undefined, timer }).alreadyActive).toBe(true);
      getMcpRecorder()!.record("tapOn", { text: "Anonymous" });
      expect(stopMcpRecording({ timer }).planContent).toContain("Anonymous");
      expect(getMcpRecorder({ connectionId: "A" })?.isRecording()).toBe(true);
    });
  });

  describe("startMcpRecording", () => {
    test("starts a recording session", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      const result = startMcpRecording({ timer });

      expect(result.recording).toBe(true);
      expect(result.startedAt).toBe(new Date(1000).toISOString());
    });

    test("returns existing session if already recording", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const timer2 = new FakeTimer();
      timer2.setCurrentTime(2000);
      const result = startMcpRecording({ timer: timer2 });

      // Should return original startedAt, not the second call's time
      expect(result.recording).toBe(true);
      expect(result.startedAt).toBe(new Date(1000).toISOString());
    });

    test("returns alreadyActive and currentStepCount on duplicate begin", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const recorder = getMcpRecorder()!;
      recorder.record("tapOn", { text: "A" });
      recorder.record("tapOn", { text: "B" });

      const result = startMcpRecording({ timer });

      expect(result.alreadyActive).toBe(true);
      expect(result.currentStepCount).toBe(2);
    });
  });

  describe("getMcpRecorder", () => {
    test("returns null when no recording active", () => {
      expect(getMcpRecorder()).toBeNull();
    });

    test("returns recorder when recording is active", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const recorder = getMcpRecorder();
      expect(recorder).not.toBeNull();
      expect(recorder!.isRecording()).toBe(true);
    });
  });

  describe("getMcpRecordingStatus", () => {
    test("returns null when no recording active", () => {
      expect(getMcpRecordingStatus()).toBeNull();
    });

    test("returns status with step count and duration", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const recorder = getMcpRecorder()!;
      recorder.record("tapOn", { text: "Login" });
      recorder.record("sendKeys", { commands: [{ action: "type", text: "test" }] });

      const statusTimer = new FakeTimer();
      statusTimer.setCurrentTime(3000);
      const status = getMcpRecordingStatus({ timer: statusTimer });

      expect(status).not.toBeNull();
      expect(status!.recording).toBe(true);
      expect(status!.stepCount).toBe(2);
      expect(status!.durationMs).toBe(2000);
    });
  });

  describe("stopMcpRecording", () => {
    test("exports launchApp without transport metadata", () => {
      const timer = new FakeTimer();
      startMcpRecording({ timer });
      getMcpRecorder()!.record("launchApp", {
        appId: "com.android.settings",
        sessionUuid: "session",
        __mcpRequestTimeoutMs: 120000,
        __mcpRequestDeadlineMs: 1790948577851,
        __foo: "reserved",
      });
      const result = stopMcpRecording({ planName: "clean-launch", timer });
      expect(result.planContent).toContain("appId: com.android.settings");
      expect(result.planContent).not.toContain("__");
    });

    test("throws when no recording active", () => {
      expect(() => stopMcpRecording()).toThrow("No active MCP recording");
    });

    test("throws when no steps were recorded", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(2000);
      expect(() => stopMcpRecording({ timer: stopTimer })).toThrow(
        "No MCP tool calls were recorded",
      );
    });

    test("returns YAML plan content with recorded steps", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const recorder = getMcpRecorder()!;
      recorder.record("launchApp", { appId: "com.test.app", platform: "android" });
      recorder.record("tapOn", { text: "Login", sessionUuid: "abc" });
      recorder.record("terminateApp", { appId: "com.test.app" });

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(5000);
      const result = stopMcpRecording({ planName: "test-plan", timer: stopTimer });

      expect(result.planName).toBe("test-plan");
      expect(result.stepCount).toBe(3);
      expect(result.durationMs).toBe(4000);
      expect(result.planContent).toContain("name: test-plan");
      expect(result.planContent).toContain("tool: launchApp");
      expect(result.planContent).toContain("tool: tapOn");
      expect(result.planContent).toContain("tool: terminateApp");
      expect(result.planContent).toContain("generatedFromToolCalls: true");
    });

    test("records a schema-valid mcpVersion (release portion only, even on a dev build)", () => {
      // Recorded plans are schema-validated (`^\d+\.\d+\.\d+$`) before migration,
      // so a dev build's git-SHA stamp must be stripped or replay is unusable.
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });
      getMcpRecorder()!.record("tapOn", { text: "Login" });

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(5000);
      const result = stopMcpRecording({ planName: "schema-test", timer: stopTimer });

      const mcpVersion = result.planContent.match(/mcpVersion:\s*(\S+)/)?.[1];
      expect(mcpVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.planContent).not.toContain("+g");
    });

    test("strips internal params from plan content", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const recorder = getMcpRecorder()!;
      recorder.record("tapOn", {
        text: "Login",
        action: "tap",
        platform: "android",
        deviceId: "emulator-5554",
        sessionUuid: "abc-123",
      });

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(2000);
      const result = stopMcpRecording({ planName: "stripped-test", timer: stopTimer });

      // Internal params should not appear in YAML
      expect(result.planContent).not.toContain("platform:");
      expect(result.planContent).not.toContain("deviceId:");
      expect(result.planContent).not.toContain("sessionUuid:");
      // But real params should
      expect(result.planContent).toContain("text: Login");
      expect(result.planContent).toContain("action: tap");
    });

    test("auto-generates plan name when not provided", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const recorder = getMcpRecorder()!;
      recorder.record("observe", {});

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(2000);
      const result = stopMcpRecording({ timer: stopTimer });

      expect(result.planName).toMatch(/^mcp-recorded-plan-/);
    });

    test("clears recording state after stop", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const recorder = getMcpRecorder()!;
      recorder.record("observe", {});

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(2000);
      stopMcpRecording({ planName: "test", timer: stopTimer });

      expect(getMcpRecorder()).toBeNull();
      expect(getMcpRecordingStatus()).toBeNull();
    });

    test("clears session when validation throws (no zombie session)", () => {
      const spy = spyOn(PlanValidator, "validate").mockImplementation(() => {
        throw new Error("validation boom");
      });

      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startMcpRecording({ timer });

      const recorder = getMcpRecorder()!;
      recorder.record("tapOn", { text: "Login" });

      expect(() => stopMcpRecording({ planName: "test", timer })).toThrow("validation boom");
      expect(getMcpRecorder()).toBeNull();
      expect(getMcpRecordingStatus()).toBeNull();

      spy.mockRestore();
    });
  });
});
