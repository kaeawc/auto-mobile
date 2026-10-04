import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { z } from "zod/v4";
import { stripNavigationInternalParams, ToolRegistryClass } from "../../src/server/toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/server/internalToolCall";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../helpers/navigationTestHarness";

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

describe("navigation recorder caller arguments", () => {
  let harness: InMemoryNavManagerHarness;
  let registry: ToolRegistryClass;
  let record: ReturnType<typeof spyOn<InMemoryNavManagerHarness["manager"], "recordToolCall">>;
  let restorePipelineOverrides: (() => void) | undefined;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
    registry = new ToolRegistryClass(new FakeTimer());
    record = spyOn(harness.manager, "recordToolCall");
    restorePipelineOverrides = registry.setPipelineOverridesForTesting({
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
    registry.registerDeviceAware("tapOn", "fake", z.object({}), async () => ({ success: true }));
  });

  afterAll(async () => {
    record?.mockRestore();
    restorePipelineOverrides?.();
    await harness?.dispose();
  });

  test("recordToolCall receives only replayable caller arguments", async () => {
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
  });
});
