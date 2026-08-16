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
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { registerToolCapabilityTools } from "../../src/server/toolCapabilityTools";
import { getToolCapabilityContext } from "../../src/features/toolCapabilities/toolCapabilityContext";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";

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

  test("denies an opt-in tool before a device session is bound", async () => {
    fixture = new McpTestFixture();
    await fixture.setup();

    ToolRegistry.clearTools();
    const handler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    ToolRegistry.register("clipboard", "clipboard", z.object({}), handler);

    await expect(fixture.client.request(
      {
        method: "tools/call",
        params: { name: "clipboard", arguments: {} },
      },
      z.any()
    )).rejects.toThrow("requires the 'clipboard' capability");

    expect(handler).not.toHaveBeenCalled();
  });

  test("rejects a capability write when the injected profile service is read-only", async () => {
    fixture = new McpTestFixture({
      sessionToolProfileService: { isEnabled: async () => false },
    });
    await fixture.setup();

    await expect(fixture.client.request(
      { method: "tools/call", params: { name: "setToolCapability", arguments: { capability: "clipboard" } } },
      z.any(),
    )).rejects.toThrow("read-only");
  });

  test("invokes an injected capability writer with its service receiver", async () => {
    const profileService = {
      calls: 0,
      isEnabled: async () => false,
      async setEnabled(): Promise<void> {
        this.calls += 1;
      },
    };
    fixture = new McpTestFixture({ sessionToolProfileService: profileService });
    await fixture.setup();

    await fixture.client.request(
      { method: "tools/call", params: { name: "setToolCapability", arguments: { capability: "clipboard" } } },
      z.any(),
    );

    expect(profileService.calls).toBe(1);
  });

  test("advertises enabled as an optional defaulted control parameter", async () => {
    fixture = new McpTestFixture();
    await fixture.setup();

    const definition = ToolRegistry.getToolDefinitions().find(tool => tool.name === "setToolCapability");
    const schema = definition?.inputSchema as { required?: string[] } | undefined;
    expect(schema?.required).toEqual(["capability"]);
  });

  test("lets a core capability control tool opt in a stdio session before device binding", async () => {
    const enabled = new Set<string>();
    const profileService: Pick<SessionToolProfileService, "isEnabled"> &
      Pick<SessionToolProfileService, "setEnabled"> = {
        isEnabled: async (_sessionUuid, capability) => enabled.has(capability),
        setEnabled: async (_sessionUuid, capability, value) => {
          if (value) {
            enabled.add(capability);
          } else {
            enabled.delete(capability);
          }
        },
      };
    fixture = new McpTestFixture({ sessionToolProfileService: profileService });
    await fixture.setup();

    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );

    const result = await fixture.client.request(
      {
        method: "tools/call",
        params: { name: "setToolCapability", arguments: { capability: "clipboard" } },
      },
      z.any()
    );
    const payload = JSON.parse(result.content[0].text) as { sessionUuid: string; capability: string; enabled: boolean };
    expect(payload).toMatchObject({ capability: "clipboard", enabled: true });
    expect(payload.sessionUuid).toMatch(/^[0-9a-f-]{36}$/);

    const listed = await fixture.client.listTools();
    expect(listed.tools.some(tool => tool.name === "clipboard")).toBe(true);
    await expect(fixture.client.request(
      { method: "tools/call", params: { name: "clipboard", arguments: {} } },
      z.any()
    )).resolves.toBeDefined();
  });

  test("keeps a generated connection profile after a plan-style device-session release", async () => {
    const enabledProfiles = new Set<string>();
    const profileService: Pick<SessionToolProfileService, "isEnabled"> &
      Pick<SessionToolProfileService, "setEnabled"> = {
        isEnabled: async (sessionUuid, capability) =>
          capability !== "test-authoring" || (sessionUuid !== undefined && enabledProfiles.has(sessionUuid)),
        setEnabled: async (sessionUuid, capability, value) => {
          if (capability === "test-authoring" && value) {
            enabledProfiles.add(sessionUuid);
          }
        },
      };
    fixture = new McpTestFixture({ sessionToolProfileService: profileService });
    await fixture.setup();
    ToolRegistry.clearTools();
    registerToolCapabilityTools();
    ToolRegistry.register(
      "executePlan",
      "executePlan",
      z.object({}),
      async () => ({
        content: [{ type: "text", text: JSON.stringify({ routingSessionUuid: getToolCapabilityContext()?.routingSessionUuid }) }],
      }),
    );

    const optIn = await fixture.client.request(
      { method: "tools/call", params: { name: "setToolCapability", arguments: { capability: "test-authoring" } } },
      z.any(),
    );
    const profileUuid = (JSON.parse(optIn.content[0].text) as { sessionUuid: string }).sessionUuid;

    const plan = await fixture.client.request(
      { method: "tools/call", params: { name: "executePlan", arguments: {} } },
      z.any(),
    );
    expect(JSON.parse(plan.content[0].text)).toEqual({});

    // A plan lifecycle release may clear device-session bindings, but it must
    // not erase the independent connection capability profile.
    SessionReleaseBroadcaster.emit(profileUuid);
    const listed = await fixture.client.listTools();
    expect(listed.tools.map(tool => tool.name)).toContain("executePlan");
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
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
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

  const listToolsForBase = async (
    isEnabled: (sessionUuid: string | undefined, capability: string) => Promise<boolean>,
  ): Promise<string[]> => {
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    fixture = new McpTestFixture({
      // Seed the transport binding to the base session so tools/list resolves the
      // same base UUID (and its label map) the call-gate sees.
      sessionContext: { sessionId: "mcp-session-1", initialSessionToolBinding: "base" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();
    ToolRegistry.clearTools();
    ToolRegistry.registerDeviceAware(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string().optional(), device: z.string().optional() }),
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const result = await fixture.client.request(
      { method: "tools/list", params: {} },
      z.any(),
    );
    return (result.tools as Array<{ name: string }>).map(tool => tool.name);
  };

  test("base disables, derived label enables -> tool IS advertised (union discovery)", async () => {
    // The call-gate accepts a `{ sessionUuid: base, device: B }` clipboard call
    // because base:B re-enables it, so tools/list must advertise it too — otherwise
    // the tool is callable but never discovered (issue #4611).
    const toolNames = await listToolsForBase(
      async (sessionUuid, capability) => capability === "clipboard" && sessionUuid === "base:B",
    );
    expect(toolNames).toContain("clipboard");
  });

  test("neither base nor any derived label enables -> tool is NOT advertised", async () => {
    // Union discovery must not over-advertise: a tool no candidate session enables
    // stays filtered out, matching the call-gate rejection.
    const toolNames = await listToolsForBase(async () => false);
    expect(toolNames).not.toContain("clipboard");
  });

  // Issue #4611 (follow-up P1): the derived-label union must be gated to
  // DEVICE-AWARE tools only. A PLAIN tool (`register`, not `registerDeviceAware`)
  // strips the `device` field via its schema and always runs under the base
  // session, so it never runs on the labeled device — it must NOT borrow a
  // label-only grant. `exportPlan` is a real plain tool and `startTestRecording`
  // a real device-aware tool; both map to the `test-authoring` capability, so the
  // ONLY difference exercised here is device-awareness.
  const callPlainExportPlan = async (
    isEnabled: (sessionUuid: string | undefined, capability: string) => Promise<boolean>,
  ) => {
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();
    ToolRegistry.clearTools();
    const handler = mock(async () => ({ content: [{ type: "text", text: "ok" }] }));
    // A plain tool: registered via `register`, its schema omits `device` (stripped
    // for real plain tools). The raw `device: "B"` argument still reaches the
    // call-gate, which must ignore it for a non-device-aware tool.
    ToolRegistry.register(
      "exportPlan",
      "exportPlan",
      z.object({ sessionUuid: z.string().optional() }),
      handler,
    );
    const call = fixture.client.request(
      {
        method: "tools/call",
        params: { name: "exportPlan", arguments: { sessionUuid: "base", device: "B" } },
      },
      z.any(),
    );
    return { call, handler };
  };

  test("plain tool: base disables, label enables -> REJECTED (no label borrowing)", async () => {
    const { call, handler } = await callPlainExportPlan(
      async (sessionUuid, capability) => capability === "test-authoring" && sessionUuid === "base:B",
    );
    await expect(call).rejects.toThrow("requires the 'test-authoring' capability");
    expect(handler).not.toHaveBeenCalled();
  });

  test("plain tool: base enables -> allowed (base-only enforcement still works)", async () => {
    const { call, handler } = await callPlainExportPlan(
      async (sessionUuid, capability) => capability === "test-authoring" && sessionUuid === "base",
    );
    await call;
    expect(handler).toHaveBeenCalledTimes(1);
  });

  const listToolsForBasePlain = async (
    isEnabled: (sessionUuid: string | undefined, capability: string) => Promise<boolean>,
  ): Promise<string[]> => {
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "mcp-session-1", initialSessionToolBinding: "base" },
      sessionToolProfileService: profileService,
    });
    await fixture.setup();
    ToolRegistry.clearTools();
    ToolRegistry.register(
      "exportPlan",
      "exportPlan",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const result = await fixture.client.request(
      { method: "tools/list", params: {} },
      z.any(),
    );
    return (result.tools as Array<{ name: string }>).map(tool => tool.name);
  };

  test("plain tool: only a label enables -> tool is NOT advertised (base-only discovery)", async () => {
    // The base-only call gate would reject a plain-tool call, so discovery must not
    // advertise a plain tool that only a label enables.
    const toolNames = await listToolsForBasePlain(
      async (sessionUuid, capability) => capability === "test-authoring" && sessionUuid === "base:B",
    );
    expect(toolNames).not.toContain("exportPlan");
  });

  test("plain tool: base enables -> tool IS advertised (base-only discovery)", async () => {
    const toolNames = await listToolsForBasePlain(
      async (sessionUuid, capability) => capability === "test-authoring" && sessionUuid === "base",
    );
    expect(toolNames).toContain("exportPlan");
  });
});
