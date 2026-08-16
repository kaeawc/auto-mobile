import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import type { SessionToolProfileService } from "../../src/features/toolCapabilities/SessionToolProfileService";
import { runWithToolCapabilityContext } from "../../src/features/toolCapabilities/toolCapabilityContext";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";

// Issue #4611 Gaps A/B/C — capability enforcement + routing/capability
// un-conflation on the MCP device-aware path.
describe("ToolRegistry capability routing and enforcement (#4611)", () => {
  const device: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };

  let restorePipelineOverrides: (() => void) | undefined;
  let originalDeviceSessionManager: unknown;

  const passthroughPipeline = (
    resolveExecutionTarget: (input: any) => Promise<any>
  ) => ToolRegistry.setPipelineOverridesForTesting({
    executionTargetResolver: { resolveExecutionTarget },
    auditRunner: {
      run: async input => input.handler(input.device, input.args, input.progress, input.signal),
    },
    afterToolCall: {
      handle: async input => ({ durationMs: 0, finalizedResponse: input.response }),
    },
    planLifecycleManager: {
      afterExecution: async () => {},
    },
  });

  beforeEach(() => {
    ToolRegistry.clearTools();
    originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
  });

  afterEach(() => {
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
  });

  test("Gap A: enforces the derived capability session of a deviceId-only call (assert consumes capabilitySessionUuid)", async () => {
    const isEnabled = mock(async () => false);
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    const handler = mock(async () => ({ success: true }));
    restorePipelineOverrides = passthroughPipeline(async input => ({
      args: input.args,
      baseSessionUuid: undefined,
      // The resolver derives this from the device's owning session for a
      // deviceId-only call. Without Gap A, enforcement saw only
      // `baseSessionUuid ?? sessionUuid` (undefined) and silently allowed.
      capabilitySessionUuid: "device-session-1",
      device,
      internalCall: false,
      sessionUuid: undefined,
      shouldResolveDevice: true,
    }));
    ToolRegistry.registerDeviceAware("clipboard", "clipboard", z.object({ deviceId: z.string() }), handler);

    await expect(runWithToolCapabilityContext(
      { sessionToolProfileService: profileService },
      () => ToolRegistry.getTool("clipboard")!.handler({ deviceId: device.deviceId }),
    )).rejects.toThrow("requires the 'clipboard' capability");

    expect(handler).not.toHaveBeenCalled();
    expect(isEnabled).toHaveBeenCalledWith("device-session-1", "clipboard");
  });

  test("Gap A end-to-end: a real deviceId-only call enforces the device's owning session", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer);
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [device]);
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    // Populates the device -> session reverse map read by getSessionForDevice.
    // The DB write is best-effort and swallowed under the unit-test DB guard.
    await sessionManager.createSession("owner-session", device.deviceId, "android");

    const fakeDeviceSessionManager = new FakeDeviceSessionManager();
    fakeDeviceSessionManager.setConnectedDevices([device]);
    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;

    const isEnabled = mock(async () => false);
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    const handler = mock(async () => ({ success: true }));
    ToolRegistry.registerDeviceAware(
      "clipboard",
      "clipboard",
      z.object({ deviceId: z.string().optional(), platform: z.string().optional() }),
      handler,
    );

    try {
      await expect(runWithToolCapabilityContext(
        { sessionToolProfileService: profileService },
        () => ToolRegistry.getTool("clipboard")!.handler({ platform: "android", deviceId: device.deviceId }),
      )).rejects.toThrow("requires the 'clipboard' capability");

      expect(handler).not.toHaveBeenCalled();
      expect(isEnabled).toHaveBeenCalledWith("owner-session", "clipboard");
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("Gap B union: enabled when the derived label grants a tool the base narrowed away", async () => {
    const isEnabled = mock(async (sessionUuid: string | undefined) => sessionUuid === "base-session:B");
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    const handler = mock(async () => ({ success: true }));
    restorePipelineOverrides = passthroughPipeline(async input => ({
      args: input.args,
      baseSessionUuid: "base-session",
      device,
      internalCall: false,
      sessionUuid: "base-session:B",
      shouldResolveDevice: true,
    }));
    ToolRegistry.registerDeviceAware("clipboard", "clipboard", z.object({ sessionUuid: z.string().optional() }), handler);

    const response = await runWithToolCapabilityContext(
      { sessionToolProfileService: profileService },
      () => ToolRegistry.getTool("clipboard")!.handler({ sessionUuid: "base-session" }),
    );

    expect(response).toEqual({ success: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("Gap B union: denied only when both base and derived narrow the tool away", async () => {
    const isEnabled = mock(async () => false);
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
    const handler = mock(async () => ({ success: true }));
    restorePipelineOverrides = passthroughPipeline(async input => ({
      args: input.args,
      baseSessionUuid: "base-session",
      device,
      internalCall: false,
      sessionUuid: "base-session:B",
      shouldResolveDevice: true,
    }));
    ToolRegistry.registerDeviceAware("clipboard", "clipboard", z.object({ sessionUuid: z.string().optional() }), handler);

    await expect(runWithToolCapabilityContext(
      { sessionToolProfileService: profileService },
      () => ToolRegistry.getTool("clipboard")!.handler({ sessionUuid: "base-session" }),
    )).rejects.toThrow("requires the 'clipboard' capability");

    expect(handler).not.toHaveBeenCalled();
    // Union consults both sessions before denying.
    expect(isEnabled).toHaveBeenCalledWith("base-session", "clipboard");
    expect(isEnabled).toHaveBeenCalledWith("base-session:B", "clipboard");
  });

  test("Gap C: a nested internal call routes with the outer call's derived session, not the base", async () => {
    let nestedSessionUuid: unknown = "UNSET";
    const nestedHandler = mock(async (args: { sessionUuid?: string }) => {
      nestedSessionUuid = args.sessionUuid;
      return { success: true };
    });
    ToolRegistry.register(
      "nestedRoutingProbe",
      "nested routing probe",
      z.object({ sessionUuid: z.string().optional() }),
      nestedHandler,
    );
    const outerHandler = mock(async () => {
      await ToolRegistry.callInternal("nestedRoutingProbe", {});
      return { success: true };
    });
    restorePipelineOverrides = passthroughPipeline(async input => ({
      args: input.args,
      baseSessionUuid: "base-session",
      device,
      internalCall: false,
      sessionUuid: "base-session:B",
      shouldResolveDevice: true,
    }));
    ToolRegistry.registerDeviceAware("outerRoutingProbe", "outer routing probe", z.object({ sessionUuid: z.string().optional() }), outerHandler);

    await ToolRegistry.getTool("outerRoutingProbe")!.handler({ sessionUuid: "base-session" });

    expect(outerHandler).toHaveBeenCalledTimes(1);
    expect(nestedHandler).toHaveBeenCalledTimes(1);
    expect(nestedSessionUuid).toBe("base-session:B");
  });

  // Gap B union at the NESTED internal-call pre-gate (issue #4611). A labeled
  // criticalSection/executePlan step routes through `callInternal` with the
  // derived `${base}:${label}` session as the ambient routing session. Before
  // the fix `invokeInternalTool` asserted that single derived session, rejecting
  // a step the base session enables but the label narrowed away. The pre-gate
  // must resolve the base from the derived label and apply the union — including
  // on the `targetDevice` path, which bypasses the device-aware wrapper's own
  // union gate entirely.
  const initializeDaemonWithLabeledBase = async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer);
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [device]);
    const pool = new DevicePool(sessionManager, "daemon-session", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession("base-session", device.deviceId, "android");
    sessionManager.setDeviceLabels("base-session", { A: "base-session", B: "base-session:B" });
    return sessionManager;
  };

  const baseEnabledDerivedDisabled = mock(
    async (sessionUuid: string | undefined, capability: string) =>
      capability === "clipboard" && sessionUuid === "base-session",
  );

  test("Gap B nested union: a labeled internal step is allowed when the base enables it but the derived label narrowed it away", async () => {
    const sessionManager = await initializeDaemonWithLabeledBase();
    try {
      const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled: baseEnabledDerivedDisabled };
      const handler = mock(async () => ({ success: true }));
      // A plain-registered tool: its handler is the raw handler with no wrapper
      // union, so `invokeInternalTool`'s pre-gate is the ONLY enforcement point.
      ToolRegistry.register("clipboard", "clipboard", z.object({}), handler);

      const response = await runWithToolCapabilityContext(
        { routingSessionUuid: "base-session:B", sessionToolProfileService: profileService },
        () => ToolRegistry.callInternal("clipboard", {}),
      );

      expect(response).toEqual({ success: true });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("Gap B nested union: the targetDevice path also honors the union (bypasses the wrapper)", async () => {
    const sessionManager = await initializeDaemonWithLabeledBase();
    try {
      const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled: baseEnabledDerivedDisabled };
      const deviceAwareHandler = mock(async () => ({ success: true }));
      ToolRegistry.registerDeviceAware("clipboard", "clipboard", z.object({}), deviceAwareHandler);

      const response = await runWithToolCapabilityContext(
        { routingSessionUuid: "base-session:B", sessionToolProfileService: profileService },
        () => ToolRegistry.callInternal("clipboard", {}, undefined, undefined, { targetDevice: device }),
      );

      expect(response).toEqual({ success: true });
      // Invoked directly with the target device, bypassing the device-aware wrapper.
      expect(deviceAwareHandler).toHaveBeenCalledTimes(1);
      expect(deviceAwareHandler.mock.calls[0][0]).toEqual(device);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("Gap B wrapper union (#4655): a device-aware internal step routed as the derived `base:B` is allowed when the base enables it", async () => {
    // The device-aware wrapper's resolver reports `baseSessionUuid = args.sessionUuid`.
    // For an internal step whose routing session is ALREADY the derived
    // `base-session:B`, that is the DERIVED value, not the true base. A wrapper
    // gate that trusted it verbatim as the union's base collapsed the union to
    // `[base-session:B, base-session:B]` and lost the base grant. The wrapper must
    // resolve the REAL base from the derived routing session so the union is
    // genuinely `[base-session, base-session:B]`.
    const sessionManager = await initializeDaemonWithLabeledBase();
    try {
      const isEnabled = mock(
        async (sessionUuid: string | undefined, capability: string) =>
          capability === "clipboard" && sessionUuid === "base-session",
      );
      const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
      const handler = mock(async () => ({ success: true }));
      restorePipelineOverrides = passthroughPipeline(async input => ({
        args: input.args,
        // Simulates the resolver on a step already routed to the derived session.
        baseSessionUuid: "base-session:B",
        device,
        internalCall: false,
        sessionUuid: "base-session:B",
        shouldResolveDevice: true,
      }));
      ToolRegistry.registerDeviceAware(
        "clipboard",
        "clipboard",
        z.object({ sessionUuid: z.string().optional() }),
        handler,
      );

      const response = await runWithToolCapabilityContext(
        { routingSessionUuid: "base-session:B", sessionToolProfileService: profileService },
        () => ToolRegistry.callInternal("clipboard", {}),
      );

      expect(response).toEqual({ success: true });
      expect(handler).toHaveBeenCalledTimes(1);
      // The wrapper gate resolved the REAL base from the derived routing session.
      expect(isEnabled).toHaveBeenCalledWith("base-session", "clipboard");
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("Gap B nested union: rejected only when both base and derived label disable the tool", async () => {
    const sessionManager = await initializeDaemonWithLabeledBase();
    try {
      const isEnabled = mock(async () => false);
      const profileService: Pick<SessionToolProfileService, "isEnabled"> = { isEnabled };
      const handler = mock(async () => ({ success: true }));
      ToolRegistry.register("clipboard", "clipboard", z.object({}), handler);

      await expect(runWithToolCapabilityContext(
        { routingSessionUuid: "base-session:B", sessionToolProfileService: profileService },
        () => ToolRegistry.callInternal("clipboard", {}),
      )).rejects.toThrow("requires the 'clipboard' capability");

      expect(handler).not.toHaveBeenCalled();
      expect(isEnabled).toHaveBeenCalledWith("base-session", "clipboard");
      expect(isEnabled).toHaveBeenCalledWith("base-session:B", "clipboard");
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });
});
