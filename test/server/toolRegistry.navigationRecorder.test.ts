import { describe, expect, test, spyOn } from "bun:test";
import { stripNavigationInternalParams, ToolRegistryClass } from "../../src/server/toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/server/internalToolCall";

describe("navigation tool call recording", () => {
  test("does not persist internal execution metadata in navigation arguments", () => {
    expect(
      stripNavigationInternalParams({
        text: "Continue",
        sessionUuid: "old-session",
        __mcpRequestDeadlineMs: 1,
        __mcpRequestTimeoutMs: 2,
        __futureInternal: true,
        _foo: "keep",
        sessionUuidX: "keep",
        session: "keep",
        __mcpSessionId: "mcp-session",
        __executionId: "execution-1",
        __executionStartTime: 123,
        [INTERNAL_NO_DIFF_PARAM]: true,
      }),
    ).toEqual({ text: "Continue", _foo: "keep", sessionUuidX: "keep", session: "keep" });
  });
});

test("recordToolCall receives only replayable caller arguments", async () => {
  const { installInMemoryNavManager } = await import("../helpers/navigationTestHarness");
  const { FakeTimer } = await import("../fakes/FakeTimer");
  const { z } = await import("zod/v4");
  const harness = await installInMemoryNavManager();
  const registry = new ToolRegistryClass(new FakeTimer());
  const record = spyOn(harness.manager, "recordToolCall");
  const restore = registry.setPipelineOverridesForTesting({
    executionTargetResolver: {
      resolveExecutionTarget: async () => ({
        shouldResolveDevice: true,
        device: { deviceId: "fake", platform: "android" },
      }),
    },
    afterToolCall: {
      handle: async (input) => ({ finalizedResponse: input.response, durationMs: 0 }),
    },
    planLifecycleManager: { afterExecution: async () => {} },
  });
  try {
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => ({ success: true }));
    await registry.getTool("tapOn")!.handler({
      text: "Continue",
      sessionUuid: "old",
      __mcpRequestTimeoutMs: 2,
      __mcpRequestDeadlineMs: 1,
      __futureInternal: true,
      _foo: "keep",
      sessionUuidX: "keep",
      session: "keep",
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toEqual({
      text: "Continue",
      _foo: "keep",
      sessionUuidX: "keep",
      session: "keep",
    });
  } finally {
    record.mockRestore();
    restore();
    await harness.dispose();
  }
});
