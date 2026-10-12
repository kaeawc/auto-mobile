import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DEVICE_OUTSIDE_MANAGED_SLOTS_CODE } from "../../src/daemon/managedSlots/managedSlotRefusal";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { DEVICE_OUTSIDE_BOUND_SESSION_CODE } from "../../src/server/deviceOutsideBoundSessionRefusal";
import {
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/server/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { ExecutionTrackerPlanExecutionLock } from "../../src/server/PlanExecutionLock";
import { executionTracker } from "../../src/server/executionTracker";
import { routedSessionUuidFromResult } from "../../src/server/routedSessionMeta";
import { SessionReleasedDuringCreationError } from "../../src/daemon/deviceAcquisitionRefusals";
import { isTypedToolRefusal, shapeToolCallError } from "../../src/server/shapeToolCallError";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

/**
 * #11292: typed refusals thrown while `executeToolCall` routes a call (before its main `try`)
 * must reach the client through the real `tools/call` dispatch as the typed result, not as an
 * untyped -32603 error. Driven through the real MCP server over an in-memory transport.
 */
const BOUND_SESSION = "bound-ios-session";
const iosDevice: BootedDevice = { name: "iPhone", deviceId: "IOS-BOUND", platform: "ios" };
const PROBE_TOOL = "__typed_refusal_probe__";

function wire(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as { text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("typed refusals thrown before executeToolCall's try (#11292)", () => {
  let restoreHermeticServer: () => void;
  let fixture: McpTestFixture | undefined;

  beforeAll(async () => {
    // Pay the server module's cold import and tool registration outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture();
    await warm.setup();
    await warm.teardown();
    restore();
  });

  beforeEach(() => {
    restoreHermeticServer = installHermeticServerFixture();
  });

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    unregisterDirectSession(BOUND_SESSION);
    DaemonState.getInstance().reset();
    restoreHermeticServer();
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    expect(executionTracker.getActiveExecutionCount()).toBe(0);
  });

  test("a control during a plan is typed; a read in the same state runs", async () => {
    const readName = `${PROBE_TOOL}_read`;
    ToolRegistry.registerDeviceAware(
      PROBE_TOOL,
      "control",
      z.object({}),
      async () => ({ content: [] }),
      {
        nonDeviceHandler: async () => ({ content: [] }),
      },
    );
    ToolRegistry.registerDeviceAware(
      readName,
      "read",
      z.object({}),
      async () => ({ content: [] }),
      {
        deviceReadOnly: true,
        nonDeviceHandler: async () => ({ content: [{ type: "text", text: "read ran" }] }),
      },
    );
    const restore = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async ({ args }) => ({
          args,
          baseSessionUuid: undefined,
          sessionUuid: undefined,
          device: undefined,
          internalCall: false,
          shouldResolveDevice: false,
        }),
      },
      afterToolCall: {
        handle: async ({ response }) => ({ durationMs: 0, finalizedResponse: response }),
      },
    });
    const plan = executionTracker.startExecution("executePlan");
    try {
      fixture = new McpTestFixture({
        daemonMode: true,
        planExecutionLock: new ExecutionTrackerPlanExecutionLock(executionTracker, {
          getScope: () => "global",
        }),
      });
      await fixture.setup();
      const result = await fixture.client.callTool({ name: PROBE_TOOL, arguments: {} });
      expect(result.isError).toBe(true);
      expect(wire(result)).toEqual({
        success: false,
        error: expect.stringContaining("plan execution in progress"),
        code: "plan_execution_in_progress",
        retryable: true,
        scope: "global",
      });
      expect(wire(result)).not.toHaveProperty("retryAfterMs");
      expect(routedSessionUuidFromResult(result)).toBeUndefined();
      const read = await fixture.client.callTool({ name: readName, arguments: {} });
      expect(read.isError).not.toBe(true);
      expect(read.content).toEqual([{ type: "text", text: "read ran" }]);
    } finally {
      executionTracker.endExecution(plan.id);
      restore();
    }
  });

  test.each([false, true])("ambiguous autolock read=%s has no session echo", async (readOnly) => {
    const devices = new FakeDeviceSessionManager();
    devices.setConnectedDevices([iosDevice, { ...iosDevice, deviceId: "IOS-OTHER" }]);
    const previous = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", devices);
    const restore = ToolRegistry.setPipelineOverridesForTesting({
      env: { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "1" },
    });
    try {
      ToolRegistry.registerDeviceAware(
        PROBE_TOOL,
        "ambiguity",
        z.object({}),
        async () => ({ content: [] }),
        { deviceReadOnly: readOnly },
      );
      fixture = new McpTestFixture({ daemonMode: true });
      await fixture.setup();
      const result = await fixture.client.callTool({ name: PROBE_TOOL, arguments: {} });
      expect(wire(result)).toMatchObject({
        code: "ambiguous_device_target",
        retryable: false,
        candidates: [
          { deviceId: "IOS-BOUND", platform: "ios" },
          { deviceId: "IOS-OTHER", platform: "ios" },
        ],
      });
      expect(routedSessionUuidFromResult(result)).toBeUndefined();
      expect(devices.getEnsureDeviceReadyCallCount()).toBe(0);
    } finally {
      restore();
      Reflect.set(ToolRegistry, "deviceSessionManager", previous);
    }
  });

  test("released creation is terminal and withdraws session use through dispatch", async () => {
    const sessionUuid = "released-creation";
    const ends: { admitted: boolean }[] = [];
    const unsubscribe = executionTracker.onSessionExecutionEnded((_sessions, end) =>
      ends.push(end),
    );
    const restore = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async ({ args }) => {
          // Reproduce the recovery admission followed by creation's terminal refusal (#11351).
          executionTracker.markSessionAdmitted(args.__executionId);
          throw new SessionReleasedDuringCreationError(sessionUuid);
        },
      },
    });
    try {
      ToolRegistry.registerDeviceAware(
        PROBE_TOOL,
        "creation",
        z.object({ sessionUuid: z.string() }),
        async () => ({ content: [] }),
      );
      fixture = new McpTestFixture({ daemonMode: true });
      await fixture.setup();
      const result = await fixture.client.callTool({
        name: PROBE_TOOL,
        arguments: { sessionUuid },
      });
      expect(routedSessionUuidFromResult(result)).toBeUndefined();
      expect(result).not.toHaveProperty("_meta");
      expect(ends).toEqual([{ admitted: false }]);
      expect(wire(result)).toMatchObject({
        success: false,
        code: "session_released_during_creation",
        sessionUuid,
        retryable: false,
        nextAction: "acquire_new_session",
      });
    } finally {
      restore();
      unsubscribe();
    }
  });

  test("creation release uses the existing terminal refusal serializer", () => {
    const error = new SessionReleasedDuringCreationError("released-creation");
    expect(isTypedToolRefusal(error)).toBe(true);
    expect(error.message).not.toContain("Retry the request");
    expect(error.message).toContain("getAndroid or getApple");
    expect(wire(shapeToolCallError(error, { toolName: "tapOn", source: "MCP" }))).toMatchObject({
      success: false,
      code: "session_released_during_creation",
      sessionUuid: "released-creation",
      retryable: false,
      nextAction: "acquire_new_session",
    });
  });

  test("device_outside_bound_session arrives as a typed result", async () => {
    registerDirectSessionDevice(BOUND_SESSION, iosDevice);
    fixture = new McpTestFixture({ sessionContext: { initialSessionToolBinding: BOUND_SESSION } });
    await fixture.setup();

    const result = await fixture.client.callTool({
      name: "tapOn",
      arguments: { platform: "android", text: "x" },
    });

    expect(result.isError).toBe(true);
    expect(wire(result)).toMatchObject({
      success: false,
      code: DEVICE_OUTSIDE_BOUND_SESSION_CODE,
      boundSessionUuid: BOUND_SESSION,
      boundDeviceId: iosDevice.deviceId,
      retryable: false,
    });
  });

  test("a seeded connection refusing another session returns the typed routing payload", async () => {
    fixture = new McpTestFixture({ sessionContext: { initialSessionToolBinding: BOUND_SESSION } });
    await fixture.setup();

    const result = await fixture.client.callTool({
      name: "tapOn",
      arguments: { sessionUuid: "other-session", text: "x" },
    });

    expect(result.isError).toBe(true);
    expect(wire(result)).toEqual({
      success: false,
      error: expect.stringMatching(/MCP connection is bound to device session/),
      code: DEVICE_OUTSIDE_BOUND_SESSION_CODE,
      boundSessionUuid: BOUND_SESSION,
      requestedSessionUuid: "other-session",
      retryable: false,
    });
  });

  test("device_outside_managed_slots arrives as a typed result", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "typed-refusal-before-try", {
        timer,
        deviceManager: new FakeDeviceUtils(),
      }),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    DaemonState.getInstance()
      .getManagedConnectionScopes()
      .bind("mcp-managed", { scopeKey: "scope-a", sessionUuids: [] });
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();

    const result = await fixture.client.callTool({
      name: "setActiveDevice",
      arguments: { deviceId: "OTHER-DEVICE", [INTERNAL_MCP_SESSION_PARAM]: "mcp-managed" },
    });

    expect(result.isError).toBe(true);
    expect(wire(result)).toMatchObject({
      success: false,
      code: DEVICE_OUTSIDE_MANAGED_SLOTS_CODE,
      retryable: false,
    });
    sessionManager.stopCleanupTimer();
  });

  test("an untyped pre-try failure still throws the MCP error", async () => {
    ToolRegistry.register(PROBE_TOOL, "probe", z.object({}), async () => ({ content: [] }));
    fixture = new McpTestFixture();
    await fixture.setup();

    await expect(
      fixture.client.callTool({ name: "__no_such_tool__", arguments: {} }),
    ).rejects.toThrow(/Unknown tool/);
  });
});
