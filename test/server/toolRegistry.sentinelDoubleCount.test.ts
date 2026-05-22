import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  RunHealthRecorder,
  __resetActiveRecorderForTests,
  clearActiveRecorder,
  setActiveRecorder,
} from "../../src/features/diagnostics/RunHealthRecorder";
import { McpCallRecorder } from "../../src/features/record/McpCallRecorder";
import {
  resetMcpRecordingState,
  startMcpRecording,
} from "../../src/server/mcpRecordingManager";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Regression coverage for the `recordedToolCall` sentinel in
 * `ToolRegistry.registerDeviceAware`. The catch block guards against double-
 * counting a tool call as a failure when **post-success bookkeeping** throws
 * after the success-path `recordToolCall(success)` has already fired.
 *
 * Without the sentinel, a thrown error from `getMcpRecorder()?.record()` (or
 * any of the other post-success hooks) would land in the catch, fire
 * `recordToolCall(failure)`, and report 2 events for 1 invocation. With the
 * sentinel, the catch sees `recordedToolCall === true` and skips the second
 * record. This test forces that exact path by:
 *   1. Spying on `McpCallRecorder.prototype.record` so it throws.
 *   2. Starting an MCP recording so `getMcpRecorder()` returns a real recorder.
 *   3. Registering a PLAN_RELEVANT_TOOL (so the post-success branch fires).
 *   4. Verifying the run-health recorder ends up with exactly one event.
 */

describe("ToolRegistry sentinel — double-count protection", function() {

  let recordSpy: ReturnType<typeof spyOn>;


  beforeEach(function() {
    ToolRegistry.clearTools();
    __resetActiveRecorderForTests();
    resetMcpRecordingState();
    recordSpy = spyOn(McpCallRecorder.prototype, "record").mockImplementation(() => {
      throw new Error("simulated post-success bookkeeping failure");
    });
  });


  afterEach(function() {
    recordSpy.mockRestore();
    ToolRegistry.clearTools();
    __resetActiveRecorderForTests();
    resetMcpRecordingState();
  });


  test("a thrown post-success bookkeeping error does not double-count the tool call", async function() {
    startMcpRecording();

    const recorder = new RunHealthRecorder({
      sessionId: "session-sentinel",
      timer: new FakeTimer(),
    });
    setActiveRecorder(recorder);

    ToolRegistry.registerDeviceAware(
      "tapOn",
      "Test tool that succeeds; getMcpRecorder().record() is rigged to throw afterwards",
      z.object({
        text: z.string().optional(),
        platform: z.enum(["ios", "android"]).optional(),
        sessionUuid: z.string().optional(),
      }),
      async () => ({ success: true }),
      false,
      false,
      {
        shouldEnsureDevice: () => false,
        nonDeviceHandler: async () => ({ success: true }),
      }
    );

    const tool = ToolRegistry.getTool("tapOn");
    expect(tool).toBeDefined();

    await expect(tool!.handler({ text: "hello" })).rejects.toThrow(
      /Failed to execute tool tapOn/
    );

    expect(recordSpy).toHaveBeenCalledTimes(1);

    const summary = recorder.finalize();
    expect(summary.toolCalls.total).toBe(1);
    expect(summary.toolCalls.successes).toBe(1);
    expect(summary.toolCalls.failures).toBe(0);
    expect(summary.toolCalls.byTool.tapOn.count).toBe(1);
    expect(summary.toolCalls.byTool.tapOn.failures).toBe(0);

    clearActiveRecorder(recorder);
  });


  test("a tool that throws before reaching the success path is recorded exactly once as a failure", async function() {
    const recorder = new RunHealthRecorder({
      sessionId: "session-throws-early",
      timer: new FakeTimer(),
    });
    setActiveRecorder(recorder);

    ToolRegistry.registerDeviceAware(
      "tapOn",
      "Test tool whose handler itself throws before any bookkeeping fires",
      z.object({ platform: z.enum(["ios", "android"]).optional() }),
      async () => ({ success: true }),
      false,
      false,
      {
        shouldEnsureDevice: () => false,
        nonDeviceHandler: async () => {
          throw new Error("handler exploded");
        },
      }
    );

    const tool = ToolRegistry.getTool("tapOn");
    await expect(tool!.handler({})).rejects.toThrow(/Failed to execute tool tapOn/);

    const summary = recorder.finalize();
    expect(summary.toolCalls.total).toBe(1);
    expect(summary.toolCalls.successes).toBe(0);
    expect(summary.toolCalls.failures).toBe(1);

    clearActiveRecorder(recorder);
  });
});
