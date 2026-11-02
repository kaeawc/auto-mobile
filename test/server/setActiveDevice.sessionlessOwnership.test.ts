import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  type InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { executionTracker, sessionExecutionMetadataOf } from "../../src/daemon/executionTracker";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * A sessionless `setActiveDevice` (e.g. `--cli setActiveDevice --device-id ...`) readied and
 * globally pinned a device another session held (#11071): CtrlProxy setup, appearance and settings
 * writes ran on the holder's device. It is refused before readiness, and a selection admitted on a
 * free device is cancelled when a session acquires that device mid-call.
 */
describe("sessionless setActiveDevice respects device ownership (#11071)", () => {
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const HOLDER = "holder-session";
  const HOLDER_CONNECTION = "holder-connection";

  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let spies: Array<ReturnType<typeof spyOn>>;

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error as InputDeviceOwnedError,
    );

  async function arrangeHarness(): Promise<void> {
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => {
        return new FakeDbWriteBarrier();
      },
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, free]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "sessionless-select-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    // Production wiring (daemon.ts): acquiring a device cancels sessionless work on it (#10829).
    manager.setDeviceAcquisitionExecutionCanceller((deviceId) => {
      executionTracker.cancelSessionlessDeviceUse(deviceId);
    });
    tools = new RealToolCallPath([held, free]).install();
    await pool.bindOrReuseDeviceSession({
      sessionId: HOLDER,
      deviceId: held.deviceId,
      platform: "android",
      allowSessionRebind: false,
      mcpSessionId: HOLDER_CONNECTION,
    });
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  afterEach(() => {
    tools.uninstall();
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  arranged("a device a live session holds is refused, typed, before readiness", async () => {
    const error = await refusal(tools.call("setActiveDevice", { deviceId: held.deviceId }));

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(error?.message).toContain(`already assigned to session ${HOLDER}`);
    expect(tools.deviceReadiness.getEnsureDeviceReadyCalls()).toBe(0);
    expect(tools.deviceReadiness.getExplicitDevicePin()).toBeUndefined();
  });

  arranged("a device an autolock owner holds is refused, typed, before readiness", async () => {
    pool.getDevice(free.deviceId)!.autolockSessionId = "autolock-owner";

    const error = await refusal(tools.call("setActiveDevice", { deviceId: free.deviceId }));

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(tools.deviceReadiness.getEnsureDeviceReadyCalls()).toBe(0);
    expect(tools.deviceReadiness.getExplicitDevicePin()).toBeUndefined();
  });

  arranged("the holder's own connection selects its device as its session (#10994)", async () => {
    const result = await tools.call("setActiveDevice", {
      deviceId: held.deviceId,
      __mcpSessionId: HOLDER_CONNECTION,
    });

    expect(JSON.stringify(result)).toContain(HOLDER);
    expect(tools.deviceReadiness.getExplicitDevicePin()).toBeUndefined();
  });

  arranged("a free device is still selected and pinned", async () => {
    await tools.call("setActiveDevice", { deviceId: free.deviceId });

    expect(tools.deviceReadiness.getExplicitDevicePin()?.deviceId).toBe(free.deviceId);
  });

  arranged(
    "a nested selection marks the enclosing execution's sessionless use of the device (#15663)",
    async () => {
      const execution = executionTracker.startExecution("executePlan");
      try {
        await runWithToolSelectionContext(
          { execution: sessionExecutionMetadataOf(execution) },
          () => ToolRegistry.callInternal("setActiveDevice", { deviceId: free.deviceId }),
        );

        // A session acquiring the device now cancels the plan, as it would at the next device step.
        expect([...(execution.sessionlessDeviceUse ?? [])]).toEqual([free.deviceId]);
      } finally {
        executionTracker.endExecution(execution.id);
      }
    },
  );

  arranged(
    "a session acquiring the device during readiness cancels the selection before the pin",
    async () => {
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      tools.deviceReadiness.setEnsureDeviceReadyHook(async () => {
        entered.resolve();
        await release.promise;
      });
      const outcome = refusal(tools.call("setActiveDevice", { deviceId: free.deviceId }));
      await entered.promise;

      await manager.createSession("late-holder", free.deviceId, "android");
      release.resolve();
      const error = await outcome;

      expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(tools.deviceReadiness.getExplicitDevicePin()).toBeUndefined();
    },
  );
});
