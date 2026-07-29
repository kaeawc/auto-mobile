import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { SessionToolProfileService } from "../../src/features/toolCapabilities/SessionToolProfileService";
import type { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

describe("session tool capability MCP enforcement", () => {
  let fixture: McpTestFixture | undefined;
  let restorePipelineOverrides: (() => void) | undefined;

  afterEach(async () => {
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    await fixture?.teardown();
    fixture = undefined;
    ToolRegistry.clearTools();
  });

  test("denies a disabled direct tool before invoking its handler", async () => {
    const isEnabled = mock(async (_sessionUuid: string | undefined, capability: string) =>
      capability === "test-authoring"
    );
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    const handler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string() }),
      handler
    );

    await expect(fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "clipboard",
          arguments: { sessionUuid: "device-session-1" },
        },
      },
      z.any()
    )).rejects.toThrow("requires the 'clipboard' capability");

    expect(isEnabled).toHaveBeenCalledWith("device-session-1", "clipboard");
    expect(handler).not.toHaveBeenCalled();
  });

  test("denies a disabled device-aware tool when its schema strips sessionUuid", async () => {
    const isEnabled = mock(async (_sessionUuid: string | undefined, capability: string) =>
      capability === "test-authoring"
    );
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    const handler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const nonDeviceHandler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    ToolRegistry.registerDeviceAware(
      "clipboard",
      "clipboard",
      z.object({}),
      handler,
      {
        shouldEnsureDevice: () => false,
        nonDeviceHandler,
      }
    );

    await expect(fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "clipboard",
          arguments: { sessionUuid: "device-session-1" },
        },
      },
      z.any()
    )).rejects.toThrow("requires the 'clipboard' capability");

    expect(isEnabled).toHaveBeenCalledWith("device-session-1", "clipboard");
    expect(handler).not.toHaveBeenCalled();
    expect(nonDeviceHandler).not.toHaveBeenCalled();
  });

  test("denies a disabled device-aware tool before resolving its target", async () => {
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async () => false,
    };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    const resolveExecutionTarget = mock(async () => {
      throw new Error("target resolution should not run");
    });
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: { resolveExecutionTarget },
    });
    ToolRegistry.registerDeviceAware(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string() }),
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );

    await expect(fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "clipboard",
          arguments: { sessionUuid: "device-session-1" },
        },
      },
      z.any()
    )).rejects.toThrow("requires the 'clipboard' capability");

    expect(resolveExecutionTarget).not.toHaveBeenCalled();
  });

  test("denies a bound session from stopping a recording without a sessionUuid", async () => {
    const isEnabled = mock(async (_sessionUuid: string | undefined, capability: string) =>
      capability !== "screen-artifacts"
    );
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string() }),
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );
    const nonDeviceHandler = mock(async () => ({ content: [{ type: "text", text: "stopped" }] }));
    ToolRegistry.registerDeviceAware(
      "videoRecording",
      "videoRecording",
      z.object({ action: z.literal("stop"), recordingId: z.string() }),
      async () => ({ content: [{ type: "text", text: "unused" }] }),
      {
        shouldEnsureDevice: () => false,
        nonDeviceHandler,
      }
    );

    await fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "clipboard",
          arguments: { sessionUuid: "device-session-1" },
        },
      },
      z.any()
    );
    await expect(fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "videoRecording",
          arguments: { action: "stop", recordingId: "recording-1" },
        },
      },
      z.any()
    )).rejects.toThrow("requires the 'screen-artifacts' capability");

    expect(isEnabled).toHaveBeenCalledWith("device-session-1", "screen-artifacts");
    expect(nonDeviceHandler).not.toHaveBeenCalled();
  });

  test("allows an enabled direct tool", async () => {
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async () => true,
    };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();

    ToolRegistry.clearTools();
    const handler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string() }),
      handler
    );

    await fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "clipboard",
          arguments: { sessionUuid: "device-session-1" },
        },
      },
      z.any()
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// Issue #4611: capability enforcement must honor the UNION of the base and the
// derived `${base}:${label}` device-label sessions at EVERY gate — a tool is
// enabled when EITHER grants it. These tests drive the PUBLIC MCP `tools/call`
// boundary (an earlier gate than the authoritative union in
// `registerDeviceAware`) with a real `device: label` so the boundary must
// resolve base + derived itself. Before the fix the boundary asserted the base
// session only and rejected a labeled call that the label re-enabled.
describe("capability union at the MCP boundary (#4611)", () => {
  const device: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
  let fixture: McpTestFixture | undefined;
  let restorePipelineOverrides: (() => void) | undefined;
  let sessionManager: SessionManager | undefined;

  const passthroughDerivedLabelPipeline = () => ToolRegistry.setPipelineOverridesForTesting({
    executionTargetResolver: {
      // Mirrors what DefaultExecutionTargetResolver returns for a
      // `{ sessionUuid: "base", device: "B" }` call: base + derived label session.
      resolveExecutionTarget: async (input: any) => ({
        args: input.args,
        baseSessionUuid: "base",
        capabilitySessionUuid: "base:B",
        device,
        internalCall: false,
        sessionUuid: "base:B",
        shouldResolveDevice: true,
      }),
    },
    auditRunner: {
      run: async (input: any) => input.handler(input.device, input.args, input.progress, input.signal),
    },
    afterToolCall: {
      handle: async (input: any) => ({ durationMs: 0, finalizedResponse: input.response }),
    },
    planLifecycleManager: {
      afterExecution: async () => {},
    },
  });

  beforeEach(async () => {
    ToolRegistry.clearTools();
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer);
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [device]);
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    // Base session with a device-label map so the boundary can resolve the
    // derived `base:B` label candidate via getDeviceLabelMap.
    await sessionManager.createSession("base", device.deviceId, "android");
    sessionManager.setDeviceLabels("base", { A: "base", B: "base:B" });
  });

  afterEach(async () => {
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    await fixture?.teardown();
    fixture = undefined;
    sessionManager?.stopCleanupTimer();
    sessionManager = undefined;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
  });

  const callLabeledClipboard = async (
    isEnabled: (sessionUuid: string | undefined, capability: string) => Promise<boolean>,
  ) => {
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();
    ToolRegistry.clearTools();
    restorePipelineOverrides = passthroughDerivedLabelPipeline();
    const handler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    ToolRegistry.registerDeviceAware(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string().optional(), device: z.string().optional() }),
      handler,
    );
    const call = fixture.client.request(
      {
        method: "tools/call",
        params: { name: "clipboard", arguments: { sessionUuid: "base", device: "B" } },
      },
      z.any(),
    );
    return { call, handler };
  };

  test("base disables, derived label enables -> allowed end-to-end (union honored at the boundary)", async () => {
    const { call, handler } = await callLabeledClipboard(
      async (sessionUuid, capability) => capability === "clipboard" && sessionUuid === "base:B",
    );
    await call;
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("base enables, derived label disables -> still allowed (union)", async () => {
    const { call, handler } = await callLabeledClipboard(
      async (sessionUuid, capability) => capability === "clipboard" && sessionUuid === "base",
    );
    await call;
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("both base and derived label disable -> rejected", async () => {
    const { call, handler } = await callLabeledClipboard(async () => false);
    await expect(call).rejects.toThrow("requires the 'clipboard' capability");
    expect(handler).not.toHaveBeenCalled();
  });
});
