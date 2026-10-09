import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry, type AuditRunnerInput } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { setDebugModeEnabled } from "../../src/utils/debug";
import { executionTracker } from "../../src/server/executionTracker";
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";

/**
 * A device another live session holds runs device-aware tools only for its holder, as `input/*`
 * already enforces (#10698). An end-to-end run found `rotate` sent with the desktop observer's
 * sessionUuid (or none) and `deviceId` of an agent-held emulator running on it. Watching stays
 * allowed on any device (#10730). The real `rotate`, `tapOn`, `sendKeys` and `observe`
 * registrations run through the real ToolRegistry target resolution; a fake audit runner stands
 * in for the device handler so an admitted call records its target instead of touching a device.
 */
describe("ToolRegistry device ownership for tool calls (#10698, #10730)", () => {
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const agent = "agent-session";
  const observer = "d0000000-0000-4000-8000-000000000001";

  let ran: Array<{ name: string; deviceId: string }>;
  let originalDeviceSessionManager: unknown;
  let originalToolCallRepository: unknown;
  let originalNavigationRecorder: unknown;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;
  let devices: FakeDeviceSessionManager;
  let gate: Promise<void> | undefined;
  let dispatched: (() => void) | undefined;

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler(args);

  async function refusal(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      await call(name, args);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  beforeEach(async () => {
    ran = [];
    ToolRegistry.clearTools();
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      auditRunner: {
        async run(input: AuditRunnerInput) {
          // A gated handler stands in for device work in flight; like a real device call it
          // honors its abort signal once it resumes.
          dispatched?.();
          if (gate) {
            await gate;
          }
          input.signal?.throwIfAborted();
          ran.push({ name: input.name, deviceId: input.device.deviceId });
          return { success: true };
        },
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
    });
    const fakeDeviceSessionManager = new FakeDeviceSessionManager();
    fakeDeviceSessionManager.setConnectedDevices([held, free]);
    devices = fakeDeviceSessionManager;
    originalDeviceSessionManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", fakeDeviceSessionManager);
    originalToolCallRepository = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall(): Promise<void> {} });
    originalNavigationRecorder = Reflect.get(ToolRegistry, "navigationToolCallRecorder");
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", { record: () => undefined });

    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [held, free]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "tool-call-ownership", {
        timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    // Production wiring (daemon.ts): acquiring a device cancels sessionless work on it (#10829).
    sessionManager.setDeviceAcquisitionExecutionCanceller((deviceId) => {
      executionTracker.cancelSessionlessDeviceUse(deviceId, {
        excludeExecutionId: getToolSelectionContext()?.execution?.executionId,
      });
    });
    await sessionManager.createSession(agent, held.deviceId, "android");
    sessionManager.setDeviceReadiness(agent, "automationReady");

    registerInteractionTools();
    registerObserveTools({
      deviceReadAccess: { listBooted: async () => [held, free], isAuthorized: () => true },
      // Watching a held device runs observe's own read-only capture, not the audit runner.
      createScreen: (device) => ({
        executeDeviceRead: async () => {
          ran.push({ name: "observe", deviceId: device.deviceId });
          return loadAndroidHomeObserve().observe;
        },
        execute: async () => {
          throw new Error("A watcher's observe must not run the session capture");
        },
        appendRawViewHierarchy: async () => {},
        getMostRecentCachedObserveResult: async () => loadAndroidHomeObserve().observe,
      }),
    });
  });

  afterEach(() => {
    gate = undefined;
    dispatched = undefined;
    restorePipeline();
    Reflect.set(ToolRegistry, "deviceSessionManager", originalDeviceSessionManager);
    Reflect.set(ToolRegistry, "toolCallRepository", originalToolCallRepository);
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", originalNavigationRecorder);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  const mutatingCalls: Array<[string, Record<string, unknown>]> = [
    ["rotate", { orientation: "landscape" }],
    ["tapOn", { text: "OK", action: "tap" }],
    ["sendKeys", { text: "hello" }],
  ];

  for (const [name, args] of mutatingCalls) {
    test(`${name} from another session's sessionUuid is refused before any device work`, async () => {
      const error = await refusal(name, {
        ...args,
        platform: "android",
        sessionUuid: observer,
        deviceId: held.deviceId,
      });
      expect(error).toBeInstanceOf(InputDeviceOwnedError);
      expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect((error as Error).message).toBe(
        `${name} refused: device '${held.deviceId}' is held by another session. ` +
          `Session ${observer} does not hold it; acquire the device (setActiveDevice) and call ` +
          `the tool with that session's sessionUuid, or wait for the holder to release it.`,
      );
      expect(ran).toEqual([]);
      expect(sessionManager.getSessionForDevice(held.deviceId)).toBe(agent);
    });

    test(`a sessionless ${name} on a held device is refused`, async () => {
      const error = await refusal(name, { ...args, platform: "android", deviceId: held.deviceId });
      expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect((error as Error).message).toContain("The request carried no sessionUuid;");
      expect(ran).toEqual([]);
    });
  }

  test("the holder's own rotate runs on its device", async () => {
    await call("rotate", { orientation: "landscape", sessionUuid: agent, deviceId: held.deviceId });
    expect(ran).toEqual([{ name: "rotate", deviceId: held.deviceId }]);
  });

  test("a sessionless rotate on an unheld device still runs", async () => {
    await call("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: free.deviceId,
    });
    expect(ran).toEqual([{ name: "rotate", deviceId: free.deviceId }]);
  });

  test("observe on a device another session holds is allowed (watching is not use)", async () => {
    await call("observe", { platform: "android", deviceId: held.deviceId });
    expect(ran).toEqual([{ name: "observe", deviceId: held.deviceId }]);
    // #10830: watching never readies the holder's device.
    expect(devices.getEnsureDeviceReadyCalls()).toBe(0);
    expect(devices.getSetCurrentDeviceCalls()).toEqual([]);
  });

  // #10828: a call without a deviceId used to run ensureDeviceReady (CtrlProxy setup, the
  // current-device pin, settings) on the held device before the ownership check refused it.
  test("a sessionless rotate with no deviceId that would land on a held device does no device work", async () => {
    devices.setConnectedDevices([held]);
    const error = await refusal("rotate", { orientation: "landscape", platform: "android" });
    expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(devices.getEnsureDeviceReadyCalls()).toBe(0);
    expect(devices.getSetCurrentDeviceCalls()).toEqual([]);
    expect(ran).toEqual([]);
  });

  test("a sessionless rotate with no deviceId is checked against the setActiveDevice pin first", async () => {
    devices.setExplicitDevicePin(held);
    const error = await refusal("rotate", { orientation: "landscape", platform: "android" });
    expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(devices.getEnsureDeviceReadyCalls()).toBe(0);
    expect(devices.getSetCurrentDeviceCalls()).toEqual([]);
  });

  test("a sessionless rotate with no deviceId on an unheld only device still readies and runs", async () => {
    devices.setConnectedDevices([free]);
    await call("rotate", { orientation: "landscape", platform: "android" });
    expect(devices.getEnsureDeviceReadyCalls()).toBe(1);
    expect(ran).toEqual([{ name: "rotate", deviceId: free.deviceId }]);
  });

  for (const [name, args] of [
    ["hitTest", { x: 10, y: 10 }],
    ["identifyInteractions", {}],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`a sessionless ${name} on a held device is refused before readiness (#10828)`, async () => {
      setDebugModeEnabled(true); // identifyInteractions is debugOnly
      const error = await refusal(name, { ...args, platform: "android", deviceId: held.deviceId });
      setDebugModeEnabled(false);
      expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(devices.getEnsureDeviceReadyCalls()).toBe(0);
      expect(devices.getSetCurrentDeviceCalls()).toEqual([]);
      expect(ran).toEqual([]);
    });
  }

  test("the refusal reaches the client with the typed code", async () => {
    const error = await refusal("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: held.deviceId,
    });
    const shaped = shapeToolCallError(error, { toolName: "rotate", source: "MCP" });
    expect(JSON.parse(shaped.content[0].text)).toEqual({
      success: false,
      error: (error as Error).message,
      code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      deviceId: held.deviceId,
      retryable: false,
    });
  });
  /** Run a call as a tracked execution, as the MCP ingress does, with the tracker's signal. */
  async function tracked(name: string, args: Record<string, unknown>): Promise<unknown> {
    const execution = executionTracker.startExecution(name);
    try {
      return await runWithToolSelectionContext(
        { execution: { executionId: execution.id, startTime: execution.startTime } },
        () =>
          ToolRegistry.getTool(name)!.handler(args, undefined, execution.abortController.signal),
      );
    } finally {
      executionTracker.endExecution(execution.id);
    }
  }

  /** Start a gated call and wait until it is in its device work. */
  async function startGated(name: string, args: Record<string, unknown>) {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    gate = release.promise;
    dispatched = () => entered.resolve();
    const outcome = tracked(name, args).then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    return { outcome, release: () => release.resolve() };
  }

  // #10829: ownership was checked once, at target resolution. A session acquiring the device while
  // a sessionless call was in flight did not stop it, so its work landed on the new holder's device.
  test("a sessionless rotate in flight is cancelled when another session acquires its device", async () => {
    const call = await startGated("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: free.deviceId,
    });
    await sessionManager.createSession("late-holder", free.deviceId, "android");
    call.release();
    const error = await call.outcome;

    expect(error).toBeInstanceOf(InputDeviceOwnedError);
    expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect((error as Error).message).toContain("acquired it while this call was in flight");
    expect(ran).toEqual([]);
  });

  test("a sessionless rotate on a device nobody acquires runs to completion", async () => {
    const call = await startGated("rotate", {
      orientation: "landscape",
      platform: "android",
      deviceId: free.deviceId,
    });
    call.release();
    expect(await call.outcome).toBeUndefined();
    expect(ran).toEqual([{ name: "rotate", deviceId: free.deviceId }]);
  });

  test("a sessionless observe in flight keeps watching after another session acquires the device", async () => {
    const call = await startGated("observe", { platform: "android", deviceId: free.deviceId });
    await sessionManager.createSession("late-holder", free.deviceId, "android");
    call.release();
    expect(await call.outcome).toBeUndefined();
    expect(ran).toEqual([{ name: "observe", deviceId: free.deviceId }]);
  });

  test("the holder's own call is not cancelled by another device's acquisition", async () => {
    const call = await startGated("rotate", {
      orientation: "landscape",
      sessionUuid: agent,
      deviceId: held.deviceId,
    });
    await sessionManager.createSession("late-holder", free.deviceId, "android");
    call.release();
    expect(await call.outcome).toBeUndefined();
    expect(ran).toEqual([{ name: "rotate", deviceId: held.deviceId }]);
  });
  /** Start a tracked call whose readiness parks until released; resolves once it is parked. */
  async function startInReadiness(name: string, args: Record<string, unknown>) {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    devices.setEnsureDeviceReadyHook(async () => {
      entered.resolve();
      await release.promise;
    });
    const outcome = tracked(name, args).then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    return { outcome, release: () => release.resolve() };
  }

  // #10905: the call was marked only after readiness, so an acquisition during a slow readiness
  // cancelled nothing and readiness went on to pin and configure the new holder's device.
  for (const [label, args] of [
    ["an explicit deviceId", { deviceId: free.deviceId }],
    ["the predicted target", {}],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`a sessionless rotate inside readiness on ${label} is cancelled when a session acquires it`, async () => {
      devices.setConnectedDevices([free]);
      const call = await startInReadiness("rotate", {
        orientation: "landscape",
        platform: "android",
        ...args,
      });
      await sessionManager.createSession("late-holder", free.deviceId, "android");
      call.release();
      const error = await call.outcome;

      expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect((error as Error).message).toContain("acquired it while this call was in flight");
      expect(devices.getSetCurrentDeviceCalls()).toEqual([]);
      expect(ran).toEqual([]);
    });
  }

  // #10970: a sessionless read was never marked, so a session acquiring its device during the
  // read's readiness cancelled nothing and readiness pinned and configured the new holder's device.
  for (const [label, args] of [
    ["an explicit deviceId", { deviceId: free.deviceId }],
    ["the predicted target", {}],
  ] as Array<[string, Record<string, unknown>]>) {
    test(`a sessionless observe inside readiness on ${label} is cancelled when a session acquires it`, async () => {
      devices.setConnectedDevices([free]);
      const call = await startInReadiness("observe", { platform: "android", ...args });
      await sessionManager.createSession("late-holder", free.deviceId, "android");
      call.release();
      const error = await call.outcome;

      expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(devices.getSetCurrentDeviceCalls()).toEqual([]);
      expect(ran).toEqual([]);
    });
  }

  test("a read that names another device than its session's watches that device (#10970)", async () => {
    await call("observe", { platform: "android", sessionUuid: agent, deviceId: free.deviceId });
    expect(ran).toEqual([{ name: "observe", deviceId: free.deviceId }]);
    expect(devices.getEnsureDeviceReadyCalls()).toBe(0);
    expect(devices.getSetCurrentDeviceCalls()).toEqual([]);
  });

  test("a control call naming another device than its session's is still refused", async () => {
    const error = await refusal("rotate", {
      orientation: "landscape",
      sessionUuid: agent,
      deviceId: free.deviceId,
    });
    expect((error as Error).message).toContain("does not match session");
    expect(ran).toEqual([]);
  });

  test("the multiple-device ambiguity asks a read for deviceId and a control call for a session", async () => {
    const read = await refusal("observe", { platform: "android" });
    expect((read as Error).message).toBe(
      "Multiple Android devices detected. Provide deviceId to target a specific device.",
    );
    const control = await refusal("rotate", { orientation: "landscape", platform: "android" });
    expect((control as Error).message).toBe(
      "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
  });

  test("a call whose readiness settles on another device than predicted moves its mark", async () => {
    const third: BootedDevice = { name: "Pixel C", deviceId: "emulator-5558", platform: "android" };
    devices.setConnectedDevices([free]);
    const readiness = await startInReadiness("rotate", {
      orientation: "landscape",
      platform: "android",
    });
    // Readiness lands on another device than the one predicted from the shared scan.
    devices.setConnectedDevices([third]);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    gate = release.promise;
    dispatched = () => entered.resolve();
    readiness.release();
    await entered.promise;

    // The predicted device is no longer this call's: acquiring it cancels nothing.
    await sessionManager.createSession("free-holder", free.deviceId, "android");
    release.resolve();
    expect(await readiness.outcome).toBeUndefined();
    expect(ran).toEqual([{ name: "rotate", deviceId: third.deviceId }]);
  });
});
