import { expect, describe, test, beforeEach, spyOn } from "bun:test";
import {
  startToolCallRecording,
  stopToolCallRecording,
  getToolCallRecordingStatus,
  getToolCallRecorder,
  resetToolCallRecordingState,
  dropToolCallRecording,
} from "../../src/server/toolCallRecordingManager";
import { PlanValidator } from "../../src/utils/plan/PlanValidator";
import { FakeTimer } from "../fakes/FakeTimer";

describe("toolCallRecordingManager", () => {
  beforeEach(() => {
    resetToolCallRecordingState();
  });

  describe("connection isolation", () => {
    test("two connections begin independently and only duplicate their own begin", () => {
      const timer = new FakeTimer();
      startToolCallRecording({ connectionId: "A", timer });
      const second = startToolCallRecording({ connectionId: "B", timer });
      expect(second.alreadyActive).toBeUndefined();
      expect(getToolCallRecorder({ connectionId: "A" })).not.toBe(
        getToolCallRecorder({ connectionId: "B" }),
      );
      expect(startToolCallRecording({ connectionId: "A", timer }).alreadyActive).toBe(true);
      expect(getToolCallRecordingStatus({ connectionId: "C", timer })).toBeNull();
      expect(getToolCallRecorder()).toBeNull();
    });

    test("ending one connection preserves the other's status and steps", () => {
      const timer = new FakeTimer();
      startToolCallRecording({ connectionId: "A", timer });
      startToolCallRecording({ connectionId: "B", timer });
      getToolCallRecorder({ connectionId: "A" })!.record("tapOn", { text: "Only A" });
      getToolCallRecorder({ connectionId: "B" })!.record("tapOn", { text: "Only B" });
      const a = stopToolCallRecording({ connectionId: "A", timer });
      expect(a.planContent).toContain("Only A");
      expect(a.planContent).not.toContain("Only B");
      expect(getToolCallRecordingStatus({ connectionId: "A", timer })).toBeNull();
      expect(getToolCallRecordingStatus({ connectionId: "B", timer })).toMatchObject({
        recording: true,
        stepCount: 1,
      });
      const b = stopToolCallRecording({ connectionId: "B", timer });
      expect(b.planContent).toContain("Only B");
      expect(b.planContent).not.toContain("Only A");
    });

    test("ending an absent connection cannot stop another recording", () => {
      const timer = new FakeTimer();
      startToolCallRecording({ connectionId: "B", timer });
      getToolCallRecorder({ connectionId: "B" })!.record("tapOn", { text: "Only B" });
      expect(() => stopToolCallRecording({ connectionId: "A", timer })).toThrow(
        "No active tool call recording",
      );
      expect(getToolCallRecordingStatus({ connectionId: "B", timer })?.stepCount).toBe(1);
    });

    test("an empty end clears only its connection", () => {
      const timer = new FakeTimer();
      startToolCallRecording({ connectionId: "A", timer });
      startToolCallRecording({ connectionId: "B", timer });
      getToolCallRecorder({ connectionId: "B" })!.record("tapOn", { text: "Only B" });
      expect(() => stopToolCallRecording({ connectionId: "A", timer })).toThrow(
        "No MCP tool calls were recorded",
      );
      expect(getToolCallRecorder({ connectionId: "A" })).toBeNull();
      expect(getToolCallRecordingStatus({ connectionId: "B", timer })?.stepCount).toBe(1);
      expect(stopToolCallRecording({ connectionId: "B", timer }).stepCount).toBe(1);
    });

    test("a validation failure clears only its connection", () => {
      const timer = new FakeTimer();
      for (const connectionId of ["A", "B"]) {
        startToolCallRecording({ connectionId, timer });
        getToolCallRecorder({ connectionId })!.record("tapOn", { text: connectionId });
      }
      const spy = spyOn(PlanValidator, "validate").mockImplementation(() => {
        throw new Error("validation boom");
      });
      try {
        expect(() => stopToolCallRecording({ connectionId: "A", timer })).toThrow(
          "validation boom",
        );
        expect(getToolCallRecorder({ connectionId: "A" })).toBeNull();
        expect(getToolCallRecordingStatus({ connectionId: "B", timer })).toMatchObject({
          recording: true,
          stepCount: 1,
        });
      } finally {
        spy.mockRestore();
      }
      expect(stopToolCallRecording({ connectionId: "B", timer }).stepCount).toBe(1);
    });

    test("drop discards only its connection and is idempotent for absent ids", () => {
      const timer = new FakeTimer();
      startToolCallRecording({ connectionId: "A", timer });
      startToolCallRecording({ connectionId: "B", timer });
      const recorder = getToolCallRecorder({ connectionId: "A" })!;
      dropToolCallRecording("unknown");
      dropToolCallRecording("A");
      dropToolCallRecording("A");
      expect(getToolCallRecordingStatus({ connectionId: "A", timer })).toBeNull();
      expect(getToolCallRecorder({ connectionId: "A" })).toBeNull();
      expect(recorder.isRecording()).toBe(false);
      expect(getToolCallRecorder({ connectionId: "B" })?.isRecording()).toBe(true);
    });

    test("anonymous calls share a default recording separate from named connections", () => {
      const timer = new FakeTimer();
      startToolCallRecording({ timer });
      startToolCallRecording({ connectionId: "A", timer });
      expect(startToolCallRecording({ connectionId: undefined, timer }).alreadyActive).toBe(true);
      getToolCallRecorder()!.record("tapOn", { text: "Anonymous" });
      expect(stopToolCallRecording({ timer }).planContent).toContain("Anonymous");
      expect(getToolCallRecorder({ connectionId: "A" })?.isRecording()).toBe(true);
    });
  });

  describe("startToolCallRecording", () => {
    test("starts a recording session", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      const result = startToolCallRecording({ timer });

      expect(result.recording).toBe(true);
      expect(result.startedAt).toBe(new Date(1000).toISOString());
    });

    test("returns existing session if already recording", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startToolCallRecording({ timer });

      const timer2 = new FakeTimer();
      timer2.setCurrentTime(2000);
      const result = startToolCallRecording({ timer: timer2 });

      // Should return original startedAt, not the second call's time
      expect(result.recording).toBe(true);
      expect(result.startedAt).toBe(new Date(1000).toISOString());
    });

    test("returns alreadyActive and currentStepCount on duplicate begin", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startToolCallRecording({ timer });

      const recorder = getToolCallRecorder()!;
      recorder.record("tapOn", { text: "A" });
      recorder.record("tapOn", { text: "B" });

      const result = startToolCallRecording({ timer });

      expect(result.alreadyActive).toBe(true);
      expect(result.currentStepCount).toBe(2);
    });
  });

  describe("getToolCallRecorder", () => {
    test("returns null when no recording active", () => {
      expect(getToolCallRecorder()).toBeNull();
    });

    test("returns recorder when recording is active", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startToolCallRecording({ timer });

      const recorder = getToolCallRecorder();
      expect(recorder).not.toBeNull();
      expect(recorder!.isRecording()).toBe(true);
    });
  });

  describe("getToolCallRecordingStatus", () => {
    test("returns null when no recording active", () => {
      expect(getToolCallRecordingStatus()).toBeNull();
    });

    test("returns status with step count and duration", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startToolCallRecording({ timer });

      const recorder = getToolCallRecorder()!;
      recorder.record("tapOn", { text: "Login" });
      recorder.record("sendKeys", { commands: [{ action: "type", text: "test" }] });

      const statusTimer = new FakeTimer();
      statusTimer.setCurrentTime(3000);
      const status = getToolCallRecordingStatus({ timer: statusTimer });

      expect(status).not.toBeNull();
      expect(status!.recording).toBe(true);
      expect(status!.stepCount).toBe(2);
      expect(status!.durationMs).toBe(2000);
    });
  });

  describe("stopToolCallRecording", () => {
    test("exports launchApp without transport metadata", () => {
      const timer = new FakeTimer();
      startToolCallRecording({ timer });
      getToolCallRecorder()!.record("launchApp", {
        appId: "com.android.settings",
        sessionUuid: "session",
        __mcpRequestTimeoutMs: 120000,
        __mcpRequestDeadlineMs: 1790948577851,
        __foo: "reserved",
      });
      const result = stopToolCallRecording({ planName: "clean-launch", timer });
      expect(result.planContent).toContain("appId: com.android.settings");
      expect(result.planContent).not.toContain("__");
    });

    test("throws when no recording active", () => {
      expect(() => stopToolCallRecording()).toThrow("No active tool call recording");
    });

    test("throws when no steps were recorded", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startToolCallRecording({ timer });

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(2000);
      expect(() => stopToolCallRecording({ timer: stopTimer })).toThrow(
        "No MCP tool calls were recorded",
      );
    });

    test("returns YAML plan content with recorded steps", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startToolCallRecording({ timer });

      const recorder = getToolCallRecorder()!;
      recorder.record("launchApp", { appId: "com.test.app", platform: "android" });
      recorder.record("tapOn", { text: "Login", sessionUuid: "abc" });
      recorder.record("terminateApp", { appId: "com.test.app" });

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(5000);
      const result = stopToolCallRecording({ planName: "test-plan", timer: stopTimer });

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
      startToolCallRecording({ timer });
      getToolCallRecorder()!.record("tapOn", { text: "Login" });

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(5000);
      const result = stopToolCallRecording({ planName: "schema-test", timer: stopTimer });

      const mcpVersion = result.planContent.match(/mcpVersion:\s*(\S+)/)?.[1];
      expect(mcpVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(result.planContent).not.toContain("+g");
    });

    test("strips internal params from plan content", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startToolCallRecording({ timer });

      const recorder = getToolCallRecorder()!;
      recorder.record("tapOn", {
        text: "Login",
        action: "tap",
        platform: "android",
        deviceId: "emulator-5554",
        sessionUuid: "abc-123",
      });

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(2000);
      const result = stopToolCallRecording({ planName: "stripped-test", timer: stopTimer });

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
      startToolCallRecording({ timer });

      const recorder = getToolCallRecorder()!;
      recorder.record("observe", {});

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(2000);
      const result = stopToolCallRecording({ timer: stopTimer });

      expect(result.planName).toMatch(/^mcp-recorded-plan-/);
    });

    test("clears recording state after stop", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startToolCallRecording({ timer });

      const recorder = getToolCallRecorder()!;
      recorder.record("observe", {});

      const stopTimer = new FakeTimer();
      stopTimer.setCurrentTime(2000);
      stopToolCallRecording({ planName: "test", timer: stopTimer });

      expect(getToolCallRecorder()).toBeNull();
      expect(getToolCallRecordingStatus()).toBeNull();
    });

    test("clears session when validation throws (no zombie session)", () => {
      const spy = spyOn(PlanValidator, "validate").mockImplementation(() => {
        throw new Error("validation boom");
      });

      const timer = new FakeTimer();
      timer.setCurrentTime(1000);
      startToolCallRecording({ timer });

      const recorder = getToolCallRecorder()!;
      recorder.record("tapOn", { text: "Login" });

      expect(() => stopToolCallRecording({ planName: "test", timer })).toThrow("validation boom");
      expect(getToolCallRecorder()).toBeNull();
      expect(getToolCallRecordingStatus()).toBeNull();

      spy.mockRestore();
    });
  });
});
