import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool, type DeviceReadinessReservation } from "../../src/daemon/devicePool";
import {
  deviceAssignedToOtherSessionError,
  devicePreparedForOtherRequestError,
  InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, Platform } from "../../src/models";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { clearDirectSessionDevices } from "../../src/server/directSessionDeviceRegistry";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import { DefaultDeviceMatcher } from "../../src/utils/deviceMatcher";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/** Force the preparation/selection interleavings at injected seams, without real device I/O. */
describe("setActiveDevice refuses a device another request is preparing (#11651)", () => {
  const platforms: Platform[] = ["android", "ios"];
  const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
  let sessions: SessionManager | undefined;
  let restoreEnv: (() => void) | undefined;

  const cleanup = () => {
    sessions?.stopCleanupTimer();
    sessions = undefined;
    restoreEnv?.();
    restoreEnv = undefined;
    resetDeviceToolsDependencies();
    clearDirectSessionDevices();
    DaemonState.getInstance().reset();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    AndroidAvdProvenanceCache.resetForTests();
  };
  afterEach(cleanup);

  async function arrange(platform: Platform) {
    const device: BootedDevice = {
      deviceId: platform === "android" ? "emulator-5554" : "11111111-1111-4111-8111-111111111111",
      name: platform === "android" ? "Pixel_8_API_34" : "iPhone 15",
      platform,
      isEmulator: true,
      osVersion: platform === "android" ? "14" : "17.2",
      ...(platform === "android" ? { apiLevel: 34 } : { iosVersion: "17.2" }),
      formFactor: "phone",
    };
    const timer = new FakeTimer();
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices(platform, [device]);
    utils.setDeviceImages(platform, [{ ...device, isRunning: true }]);
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const manager = sessions;
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "preparation-daemon", {
        env,
        timer,
        deviceManager: utils,
      }),
    );
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(manager, pool);
    PlatformDeviceManagerFactory.setInstance(utils);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let readinessCalls = 0;
    let readinessFailure: Error | undefined;
    setDeviceToolsDependencies({
      env,
      timer,
      deviceManagerFactory: () => utils,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      idGenerator: new CountingIdGenerator("preparer"),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        if (readinessCalls === 1) {
          entered.resolve();
          await gate.promise;
          if (readinessFailure) {
            throw readinessFailure;
          }
        }
      },
    });
    setDeviceManager(utils);
    registerDeviceTools();
    const startArgs = {
      platform,
      ...(platform === "ios" ? { deviceId: device.deviceId } : { name: device.name }),
    };
    const start = (caller = "client-a", signal?: AbortSignal, selector = false) =>
      runWithAbortSignal(signal, () =>
        ToolRegistry.getTool("startDevice")!.handler(
          { ...(selector ? { platform } : startArgs), __mcpSessionId: caller },
          undefined,
          signal,
        ),
      );
    const resumed: string[] = [];
    const selected = createSetActiveDeviceHandler({
      resumeCtrlProxy: async (id) => {
        resumed.push(id);
      },
    });
    const select = () =>
      selected({
        deviceId: device.deviceId,
        sessionUuid: "other-session",
        __mcpSessionId: "client-b",
      });
    const drain = async () => {
      for (let second = 0; second < 5; second++) {
        for (let turn = 0; turn < 100; turn++) {
          await Promise.resolve();
        }
        timer.advanceTime(1_000);
      }
    };
    return {
      device,
      pool,
      manager,
      start,
      select,
      resumed,
      entered: entered.promise,
      release: () => gate.resolve(),
      fail: () => {
        readinessFailure = new Error("runner failed");
      },
      readinessCalls: () => readinessCalls,
      drain,
    };
  }

  const refusal = (pending: Promise<unknown>): Promise<unknown> =>
    pending.then(
      () => undefined,
      (error: unknown) => error,
    );
  const expectPreparationRefusal = (error: unknown, deviceId: string) => {
    expect(error).toBeInstanceOf(InputDeviceOwnedError);
    expect(error).toMatchObject({
      code: "device_owned_by_other_session",
      deviceId,
      retryable: true,
      retryAfterMs: 2000,
    });
    expect((error as Error).message).toContain("being prepared for another request");
    expect((error as Error).message).not.toContain("assigned to session");
    expect((error as InputDeviceOwnedError).toPayload()).toEqual({
      code: "device_owned_by_other_session",
      deviceId,
      retryable: true,
      retryAfterMs: 2000,
    });
  };
  const expectHeldRefusal = (error: unknown, deviceId: string) => {
    expect(error).toBeInstanceOf(InputDeviceOwnedError);
    expect((error as InputDeviceOwnedError).toPayload()).toEqual({
      code: "device_owned_by_other_session",
      deviceId,
      retryable: false,
    });
    expect(Object.hasOwn(error as InputDeviceOwnedError, "retryAfterMs")).toBe(false);
  };

  // Pay initial module/JIT costs on throwaway pools; each test still runs its complete scenario.
  beforeAll(async () => {
    for (const platform of platforms) {
      const h = await arrange(platform);
      const first = h.start();
      await h.entered;
      h.release();
      await first;
      await refusal(h.select());
      cleanup();
    }
  });

  test.each(platforms)(
    "%s: selection before reservation binds, and start is refused",
    async (platform) => {
      const h = await arrange(platform);
      await h.select();
      expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBe("other-session");
      expectHeldRefusal(await refusal(h.start()), h.device.deviceId);
      expect(h.readinessCalls()).toBe(0);
      expect(h.pool.isReservedForReadiness(h.device.deviceId)).toBe(false);
    },
  );

  test.each(platforms)(
    "%s: session selection during readiness is refused before resume",
    async (platform) => {
      const h = await arrange(platform);
      const first = h.start();
      await h.entered;
      try {
        expectPreparationRefusal(await refusal(h.select()), h.device.deviceId);
        expect(h.resumed).toEqual([]);
        expect(h.manager.getSession("other-session")).toBeNull();
        expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBeNull();
      } finally {
        h.release();
        await first;
      }
      expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBeTruthy();
      expect(h.pool.isReservedForReadiness(h.device.deviceId)).toBe(false);
    },
  );

  test.each(platforms)(
    "%s: sessionless selection during readiness is refused before readying or pinning",
    async (platform) => {
      const h = await arrange(platform);
      const first = h.start();
      await h.entered;
      const calls: string[] = [];
      const select = createSetActiveDeviceHandler({
        resumeCtrlProxy: async () => {
          calls.push("resume");
        },
        legacyDeviceSelection: () => ({
          getCurrentDevice: () => undefined,
          getCurrentPlatform: () => undefined,
          ensureDeviceReady: async () => {
            calls.push("ready");
            return h.device;
          },
          setExplicitDevicePin: () => {
            calls.push("pin");
          },
        }),
      });
      try {
        expectPreparationRefusal(
          await refusal(select({ deviceId: h.device.deviceId, __mcpSessionId: "client-b" })),
          h.device.deviceId,
        );
        expect(calls).toEqual([]);
      } finally {
        h.release();
        await first;
      }
    },
  );

  test.each(platforms)(
    "%s: after the preparation binds the refusal is non-retryable",
    async (platform) => {
      const h = await arrange(platform);
      const first = h.start();
      await h.entered;
      h.release();
      await first;
      expectHeldRefusal(await refusal(h.select()), h.device.deviceId);
      expect(h.resumed).toEqual([]);
    },
  );

  test.each(platforms)(
    "%s: failed warm readiness releases preparation and a retry binds",
    async (platform) => {
      const h = await arrange(platform);
      const first = refusal(h.start());
      await h.entered;
      try {
        expectPreparationRefusal(await refusal(h.select()), h.device.deviceId);
      } finally {
        h.fail();
        h.release();
        await first;
      }
      expect(await first).toBeInstanceOf(Error);
      await h.drain();
      expect(h.pool.isReservedForReadiness(h.device.deviceId)).toBe(false);
      await h.select();
      expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBe("other-session");
    },
  );

  test.each(platforms)(
    "%s: cancelled readiness releases preparation and a retry binds",
    async (platform) => {
      const h = await arrange(platform);
      const controller = new AbortController();
      const first = refusal(h.start("client-a", controller.signal));
      await h.entered;
      try {
        expectPreparationRefusal(await refusal(h.select()), h.device.deviceId);
      } finally {
        controller.abort(new Error("cancelled"));
        h.release();
        await first;
      }
      expect(await first).toBeInstanceOf(Error);
      await h.drain();
      expect(h.pool.isReservedForReadiness(h.device.deviceId)).toBe(false);
      await h.select();
      expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBe("other-session");
    },
  );

  test.each(platforms)(
    "%s: a reservation during resume is refused at bind, then retry binds",
    async (platform) => {
      const h = await arrange(platform);
      let reservation: DeviceReadinessReservation | undefined;
      const select = createSetActiveDeviceHandler({
        resumeCtrlProxy: async () => {
          reservation = await h.pool.reserveDeviceForReadiness(
            h.device.deviceId,
            h.device,
            undefined,
            undefined,
            { mcpSessionId: "client-a" },
          );
        },
      });
      try {
        expectPreparationRefusal(
          await refusal(
            select({
              deviceId: h.device.deviceId,
              sessionUuid: "other-session",
              __mcpSessionId: "client-b",
            }),
          ),
          h.device.deviceId,
        );
        expect(h.manager.getSession("other-session")).toBeNull();
        expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBeNull();
      } finally {
        await reservation?.();
      }
      await h.select();
      expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBe("other-session");
    },
  );

  test.each(platforms)("%s: listDevices remains open during readiness", async (platform) => {
    const h = await arrange(platform);
    const first = h.start();
    await h.entered;
    try {
      const result = await ToolRegistry.getTool("listDevices")!.handler({ platform });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(result.content[0].text) as {
        devices: Array<{ runtime: { deviceId: string } }>;
      };
      expect(payload.devices.some((device) => device.runtime.deviceId === h.device.deviceId)).toBe(
        true,
      );
    } finally {
      h.release();
      await first;
    }
  });

  test.each(platforms)(
    "%s: a holder reselects through its own readiness reservation",
    async (platform) => {
      const h = await arrange(platform);
      const first = h.start();
      await h.entered;
      h.release();
      await first;
      const holder = h.pool.getDevice(h.device.deviceId)!.sessionId!;
      const reservation = await h.pool.reserveDeviceForReadiness(
        h.device.deviceId,
        h.device,
        undefined,
        undefined,
        { mcpSessionId: "client-a" },
      );
      const select = createSetActiveDeviceHandler({ resumeCtrlProxy: async () => {} });
      try {
        await select({
          deviceId: h.device.deviceId,
          sessionUuid: holder,
          __mcpSessionId: "client-a",
        });
        expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBe(holder);
        expectHeldRefusal(await refusal(h.select()), h.device.deviceId);
      } finally {
        await reservation();
      }
    },
  );

  test.each(platforms)(
    "%s: a second start waits on the lifecycle lease, then gets the held refusal",
    async (platform) => {
      const h = await arrange(platform);
      // The selector and explicit start converge on the real device's canonical lifecycle identity.
      const first = h.start("client-a", undefined, true);
      await h.entered;
      let secondSettled = false;
      const second = refusal(h.start("client-b")).then((outcome) => {
        secondSettled = true;
        return outcome;
      });
      try {
        for (let turn = 0; turn < 200; turn++) {
          await Promise.resolve();
        }
        expect(h.pool.isReservedForReadiness(h.device.deviceId)).toBe(true);
        expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBeNull();
        expect(secondSettled).toBe(false);
        expect(h.readinessCalls()).toBe(1);
      } finally {
        h.release();
        await first;
      }
      expectHeldRefusal(await second, h.device.deviceId);
      expect(h.readinessCalls()).toBe(1);
      expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBeTruthy();
      expect(h.pool.isReservedForReadiness(h.device.deviceId)).toBe(false);
    },
  );

  test.each(platforms)(
    "%s: internal binds are permissive, flagged binds refuse only other owners",
    async (platform) => {
      for (const [flag, own] of [
        [true, false],
        [false, false],
        [true, true],
      ]) {
        const h = await arrange(platform);
        const reservation = await h.pool.reserveDeviceForReadiness(h.device.deviceId, h.device);
        try {
          const pending = h.pool.bindOrReuseDeviceSession(
            "other-session",
            h.device.deviceId,
            platform,
            undefined,
            undefined,
            undefined,
            true,
            own ? new Set([reservation.owner]) : undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            flag,
          );
          if (flag && !own) {
            expectPreparationRefusal(await refusal(pending), h.device.deviceId);
            expect(h.manager.getSession("other-session")).toBeNull();
            expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBeNull();
          } else {
            expect(await pending).toBe("other-session");
            expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBe("other-session");
          }
        } finally {
          await reservation();
          cleanup();
        }
      }
    },
  );

  test("wire payloads distinguish preparation from a held device without an undefined own property", () => {
    const preparing = devicePreparedForOtherRequestError("device");
    expectPreparationRefusal(preparing, "device");
    const held = deviceAssignedToOtherSessionError("device", "holder", "stranger");
    expectHeldRefusal(held, "device");
  });
});
