import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { BootedDevice, DeviceInfo } from "../../src/models";

import { FakeEmulatorConsoleBusyRegistry } from "../fakes/FakeEmulatorConsoleBusyRegistry";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  createBootedDevice,
  createDevicePoolSuite,
  devicePoolSuiteActions,
  requirePooledDevice,
} from "../helpers/devicePoolSuite";

useSessionIdleWindowForSuite();

describe("DevicePool", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeDeviceManager: FakeDeviceManager;
  const { initializeLiveDevices, makePool } = devicePoolSuiteActions(() => ({
    devicePool,
    sessionManager,
    fakeTimer,
    fakeAppsRepo,
    fakeDeviceManager,
  }));

  beforeEach(() => {
    ({ devicePool, sessionManager, fakeTimer, fakeAppsRepo, fakeDeviceManager } =
      createDevicePoolSuite());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });
  // A pooled emulator entry whose LATEST discovery observation carries the
  // `Unknown (<serial>)` placeholder is not evicted -- the placeholder is not
  // evidence that a different AVD took the serial -- but it is no longer
  // evidence of continuity either. Between those two, the entry is QUARANTINED:
  // kept (session and incarnation intact) but withheld from assignment, from
  // serial-addressed tool execution and from anything the pool publishes, until
  // a resolved name proves which runtime is actually on the serial
  // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
  describe("unresolved emulator identity quarantine", () => {
    const androidImage: DeviceInfo = {
      name: "Pixel_8_API_35",
      platform: "android",
      isRunning: false,
      source: "local",
    };

    const poolDevice = (deviceId: string, name: string): BootedDevice =>
      createBootedDevice(deviceId, "android", name);

    const unresolved = (deviceId: string): BootedDevice =>
      createBootedDevice(deviceId, "android", `Unknown (${deviceId})`);

    const refreshWith = async (devices: BootedDevice[]): Promise<void> => {
      fakeDeviceManager.bootedDevices = [...devices];
      await devicePool.refreshDevices();
    };

    test("refresh ignores foreign placeholders and resolved names without changing identity", async () => {
      const device = poolDevice("emulator-5610", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      const pooled = requirePooledDevice(devicePool, device.deviceId);
      const before = { ...pooled };
      await refreshWith([{ ...unresolved(device.deviceId), foreignOwned: true, observedAt: 20 }]);
      expect(pooled).toEqual(before);
      pooled.identityUnresolved = true;
      await refreshWith([{ ...device, foreignOwned: true, observedAt: 21 }]);
      expect(pooled.identityUnresolved).toBe(true);
      expect(pooled.identityObservedAt).toBe(before.identityObservedAt);
    });

    test("immediately quarantines a live entry without a confirmed AVD identity", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      const incarnation = devicePool.getDevice("emulator-5554")?.incarnation;

      await refreshWith([unresolved("emulator-5554")]);

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
      // Kept, not evicted: same entry, same incarnation.
      expect(devicePool.getDevice("emulator-5554")?.incarnation).toBe(incarnation!);
    });

    test("keeps a confirmed session actionable while unreadable identity retries recover", async () => {
      const device = { ...poolDevice("emulator-5554", "Pixel_8_API_35"), observedAt: 1 };
      const firstOmission = { ...unresolved(device.deviceId), observedAt: 2 };
      const secondOmission = { ...unresolved(device.deviceId), observedAt: 3 };
      const recovered = { ...device, observedAt: 4 };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
        sourceImage: androidImage,
      });
      const pooled = devicePool.getDevice(device.deviceId);
      const incarnation = pooled?.incarnation;
      const assignmentCount = pooled?.assignmentCount;
      const finalRetryStarted = Promise.withResolvers<void>();
      const releaseFinalRetry = Promise.withResolvers<void>();
      const getBootedDevicesDetailed =
        fakeDeviceManager.getBootedDevicesDetailed.bind(fakeDeviceManager);
      let retryCalls = 0;
      fakeDeviceManager.getBootedDevicesDetailed = async (platform) => {
        retryCalls++;
        if (retryCalls === 1) {
          fakeDeviceManager.bootedDevices = [secondOmission];
          return await getBootedDevicesDetailed(platform);
        }
        finalRetryStarted.resolve();
        await releaseFinalRetry.promise;
        fakeDeviceManager.bootedDevices = [recovered];
        return await getBootedDevicesDetailed(platform);
      };

      const reconciliation = devicePool.reconcileDiscoveryObservation(
        [firstOmission],
        "test:temporary-name-omission",
      );
      await finalRetryStarted.promise;

      expect(devicePool.getDevice(device.deviceId)).toMatchObject({
        identityReconcileAttempts: 3,
        identityObservedAt: 1,
        sessionId: "owner-session",
      });
      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(false);
      expect(() => devicePool.assertDeviceActionable(device.deviceId, "test action")).not.toThrow();
      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).not.toThrow();

      releaseFinalRetry.resolve();
      await reconciliation;

      expect(retryCalls).toBe(2);
      expect(devicePool.getDevice(device.deviceId)).toMatchObject({
        avdName: device.name,
        assignmentCount,
        incarnation,
        identityObservedAt: 4,
        sessionId: "owner-session",
      });
      expect(devicePool.getDevice(device.deviceId)?.identityReconcileAttempts).toBeUndefined();
      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(false);
    });

    test("immediately fences a different resolved name during identity retries", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      const different = poolDevice(device.deviceId, "Pixel_7_API_34");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
        sourceImage: androidImage,
      });
      fakeDeviceManager.bootedDevices = [different];
      const getBootedDevicesDetailed =
        fakeDeviceManager.getBootedDevicesDetailed.bind(fakeDeviceManager);
      let retryCalls = 0;
      fakeDeviceManager.getBootedDevicesDetailed = async (platform) => {
        retryCalls++;
        return await getBootedDevicesDetailed(platform);
      };

      await devicePool.reconcileDiscoveryObservation(
        [unresolved(device.deviceId)],
        "test:mismatch-during-name-retry",
      );

      expect(retryCalls).toBe(1);
      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(true);
      expect(() => devicePool.assertDeviceActionable(device.deviceId, "test action")).toThrow(
        /identity is unresolved/,
      );
      expect(devicePool.getDevice(device.deviceId)?.sessionId).toBe("owner-session");
    });

    test("C1 stale reconciliation cannot clear a newer cycle at the same attempt", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
        sourceImage: androidImage,
      });
      const enteredA = Promise.withResolvers<void>();
      const enteredB = Promise.withResolvers<void>();
      const releaseA = Promise.withResolvers<void>();
      const releaseB = Promise.withResolvers<void>();
      const discover = fakeDeviceManager.getBootedDevicesDetailed.bind(fakeDeviceManager);
      let calls = 0;
      fakeDeviceManager.getBootedDevicesDetailed = async (platform) => {
        const call = ++calls;
        if (call === 1) {
          enteredA.resolve();
          await releaseA.promise;
        }
        if (call === 2) {
          enteredB.resolve();
          await releaseB.promise;
        }
        fakeDeviceManager.bootedDevices = [unresolved(device.deviceId)];
        return discover(platform);
      };
      const cycleA = devicePool.reconcileDiscoveryObservation(
        [unresolved(device.deviceId)],
        "test:C1-A",
      );
      await enteredA.promise;
      const blockedDiscover = fakeDeviceManager.getBootedDevicesDetailed;
      fakeDeviceManager.getBootedDevicesDetailed = discover;
      await refreshWith([device]);
      fakeDeviceManager.getBootedDevicesDetailed = blockedDiscover;
      const cycleB = devicePool.reconcileDiscoveryObservation(
        [unresolved(device.deviceId)],
        "test:C1-B",
      );
      await enteredB.promise;
      releaseA.resolve();
      await cycleA;
      const attemptsWhileBPending = devicePool.getDevice(
        device.deviceId,
      )?.identityReconcileAttempts;
      releaseB.resolve();
      await cycleB;
      expect(attemptsWhileBPending).toBe(2);
      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(true);
    });

    test("C2 ambient shutdown abort stops identity rediscovery without quarantine", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
        sourceImage: androidImage,
      });
      const controller = new AbortController();
      let calls = 0;
      fakeDeviceManager.getBootedDevicesDetailed = async () => {
        calls++;
        controller.abort(new Error("shutdown deadline"));
        throw controller.signal.reason;
      };
      await runWithAbortSignal(controller.signal, () =>
        devicePool.reconcileDiscoveryObservation(
          [unresolved(device.deviceId)],
          "shutdown-preflight",
        ),
      );
      expect(calls).toBe(1);
      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(false);
      expect(devicePool.getDevice(device.deviceId)?.identityReconcileAttempts).toBeUndefined();
    });

    test("terminally quarantines a confirmed identity after the retry bound", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
        sourceImage: androidImage,
      });
      fakeDeviceManager.bootedDevices = [unresolved(device.deviceId)];
      const getBootedDevicesDetailed =
        fakeDeviceManager.getBootedDevicesDetailed.bind(fakeDeviceManager);
      let retryCalls = 0;
      fakeDeviceManager.getBootedDevicesDetailed = async (platform) => {
        retryCalls++;
        return await getBootedDevicesDetailed(platform);
      };

      await devicePool.reconcileDiscoveryObservation(
        [unresolved(device.deviceId)],
        "test:permanently-unreadable-name",
      );

      expect(retryCalls).toBe(2);
      expect(devicePool.getDevice(device.deviceId)?.identityReconcileAttempts).toBeUndefined();
      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(true);
      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).toThrow(
        /identity is unresolved/,
      );
    });

    test("restores a quarantined entry when the same AVD name is read again", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      const incarnation = devicePool.getDevice("emulator-5554")?.incarnation;
      await refreshWith([unresolved("emulator-5554")]);
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);

      await refreshWith([device]);

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(false);
      expect(devicePool.getDevice("emulator-5554")?.incarnation).toBe(incarnation!);
    });

    test("replaces a quarantined entry when a different AVD name is read", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      const incarnation = devicePool.getDevice("emulator-5554")!.incarnation;
      await refreshWith([unresolved("emulator-5554")]);

      await refreshWith([poolDevice("emulator-5554", "Pixel_7_API_34")]);

      const replacement = devicePool.getDevice("emulator-5554");
      expect(replacement?.name).toBe("Pixel_7_API_34");
      expect(replacement?.incarnation).toBeGreaterThan(incarnation);
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(false);
    });

    test("does not assign an idle emulator while its identity is unresolved", async () => {
      await initializeLiveDevices([
        poolDevice("emulator-5554", "Pixel_8_API_35"),
        poolDevice("emulator-5556", "Pixel_7_API_34"),
      ]);
      await refreshWith([
        unresolved("emulator-5554"),
        poolDevice("emulator-5556", "Pixel_7_API_34"),
      ]);

      const assigned = await devicePool.assignDeviceToSession("session-1");

      expect(assigned).toBe("emulator-5556");
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
    });

    // The quarantine can be ENTERED by the assignment-time liveness check itself,
    // with no refresh sweep in between. The operation that enters it must fail at
    // assignment rather than hand back a session that then fails every tool
    // (#6863 review).
    test("does not assign an emulator the assignment-time liveness check just quarantined", async () => {
      await initializeLiveDevices([
        poolDevice("emulator-5554", "Pixel_8_API_35"),
        poolDevice("emulator-5556", "Pixel_7_API_34"),
      ]);
      // No refresh: the placeholder is what the assignment's own discovery reads.
      fakeDeviceManager.bootedDevices = [
        unresolved("emulator-5554"),
        poolDevice("emulator-5556", "Pixel_7_API_34"),
      ];

      const assigned = await devicePool.assignDeviceToSession("session-1");

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
      expect(assigned).toBe("emulator-5556");
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
    });

    test("assigns the entry again once a later sweep resolves the name", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await refreshWith([unresolved("emulator-5554")]);
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);

      await refreshWith([device]);
      const assigned = await devicePool.assignDeviceToSession("session-1");

      expect(assigned).toBe("emulator-5554");
    });

    test("refuses an exact bind whose liveness check finds an unresolved identity", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      fakeDeviceManager.bootedDevices = [unresolved("emulator-5554")];

      await expect(
        devicePool.bindOrReuseDeviceSession({
          sessionId: "session-1",
          deviceId: "emulator-5554",
          platform: "android",
          sourceImage: androidImage,
        }),
      ).rejects.toThrow(/emulator-5554[\s\S]*identity is unresolved/);
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
    });

    test("refuses an autolock whose liveness check finds an unresolved identity", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      try {
        const device = poolDevice("emulator-5554", "Pixel_8_API_35");
        await initializeLiveDevices([device]);
        fakeDeviceManager.bootedDevices = [unresolved("emulator-5554")];

        await expect(
          devicePool.autolockDevice("emulator-5554", "android", "mcp-session-1"),
        ).rejects.toThrow(/emulator-5554[\s\S]*identity is unresolved/);
        expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
      } finally {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });

    test("refuses tool execution for a session bound to an unresolved emulator", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: "emulator-5554",
        platform: "android",
        sourceImage: androidImage,
      });
      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).not.toThrow();

      await refreshWith([unresolved("emulator-5554")]);

      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).toThrow(
        /emulator-5554/,
      );
      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).toThrow(
        /Pixel_8_API_35/,
      );
      // The session survives the quarantine: it is refused, not released.
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("owner-session");
    });

    test("withholds published pool context while the identity is unresolved", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await refreshWith([unresolved("emulator-5554")]);

      // Even a later observation that HAPPENS to carry the pooled name cannot
      // publish pool context until a discovery sweep lifts the quarantine.
      expect(devicePool.describesPooledRuntime(device)).toBe(false);
    });

    // A resolved name that DISAGREES is a replacement, and the pool installs it
    // by evicting the old incarnation. `evictMissingPooledDevice` deliberately
    // DEFERS that eviction while killDevice holds a shutdown reservation, so the
    // refresh reloads the very entry the discovered runtime disagrees with. That
    // entry must stay quarantined until the replacement actually installs --
    // otherwise the disagreeing name reads as proof of continuity and re-admits
    // the old session's tools and stream routing to a different AVD
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    test("keeps the quarantine when a differing name arrives while eviction is deferred", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      const incarnation = devicePool.getDevice("emulator-5554")!.incarnation;
      await refreshWith([unresolved("emulator-5554")]);
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
      const reservation = await devicePool.reserveDeviceForShutdown("emulator-5554");
      expect(reservation).toBeDefined();

      await refreshWith([poolDevice("emulator-5554", "Pixel_7_API_34")]);

      // Eviction was deferred, so this is still the OLD incarnation -- and it is
      // still untrusted.
      expect(devicePool.getDevice("emulator-5554")?.incarnation).toBe(incarnation);
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);

      await reservation!.release();
      await refreshWith([poolDevice("emulator-5554", "Pixel_7_API_34")]);

      const replacement = devicePool.getDevice("emulator-5554");
      expect(replacement?.name).toBe("Pixel_7_API_34");
      expect(replacement?.incarnation).toBeGreaterThan(incarnation);
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(false);
    });

    // Same deferral, but the entry was NOT quarantined beforehand: the
    // disagreement itself is what makes the pooled label untrustworthy.
    test("quarantines a live entry whose deferred replacement disagrees with it", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      const incarnation = devicePool.getDevice("emulator-5554")!.incarnation;
      const reservation = await devicePool.reserveDeviceForShutdown("emulator-5554");

      await refreshWith([poolDevice("emulator-5554", "Pixel_7_API_34")]);

      expect(devicePool.getDevice("emulator-5554")?.incarnation).toBe(incarnation);
      expect(devicePool.getDevice("emulator-5554")?.name).toBe("Pixel_8_API_35");
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
      await reservation!.release();
    });

    // Entering the quarantine must also stop the work already in flight on the
    // bound session. The admission gate only refuses LATER calls, while an
    // execution already registered in `executionTracker` keeps issuing
    // serial-addressed operations that can land on a replacement AVD
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    test("cancels the bound session's in-flight executions when entering quarantine", async () => {
      const cancellations: { sessionId: string; reason: string }[] = [];
      devicePool = makePool({
        cancelDeviceSessionExecutions: async (sessionId, reason) => {
          cancellations.push({ sessionId, reason });
          return 1;
        },
      });
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: "emulator-5554",
        platform: "android",
        sourceImage: androidImage,
      });
      const incarnation = devicePool.getDevice("emulator-5554")!.incarnation;

      await refreshWith([unresolved("emulator-5554")]);

      expect(cancellations.map((entry) => entry.sessionId)).toEqual(["owner-session"]);
      expect(cancellations[0]?.reason).toContain("emulator-5554");
      // Session and incarnation survive the quarantine: it withholds trust, it
      // does not retire the epoch.
      const quarantined = devicePool.getDevice("emulator-5554");
      expect(quarantined?.sessionId).toBe("owner-session");
      expect(quarantined?.incarnation).toBe(incarnation);
    });

    test("stops a stale aborted observation before it can quarantine a newly bound emulator", async () => {
      const cancellations: { sessionId: string; reason: string }[] = [];
      devicePool = makePool({
        cancelDeviceSessionExecutions: async (sessionId, reason) => {
          cancellations.push({ sessionId, reason });
          return 1;
        },
      });
      const first = poolDevice("emulator-5554", "Pixel_8_API_35");
      const second = poolDevice("emulator-5556", "Pixel_7_API_34");
      await initializeLiveDevices([first, second]);
      const controller = new AbortController();
      const runtimeIdentity = devicePool.testHooks.runtimeIdentity;
      const reconcileObservedPooledIdentity =
        runtimeIdentity.reconcileObservedPooledIdentity.bind(runtimeIdentity);
      let processedDevices = 0;
      runtimeIdentity.reconcileObservedPooledIdentity = async (pooled, device, options) => {
        await reconcileObservedPooledIdentity(pooled, device, options);
        processedDevices++;
        if (processedDevices === 1) {
          controller.abort();
          await devicePool.bindOrReuseDeviceSession({
            sessionId: "unrelated-live-session",
            deviceId: second.deviceId,
            platform: "android",
            sourceImage: {
              name: second.name,
              platform: "android",
              isRunning: false,
              source: "local",
            },
          });
        }
      };

      await devicePool.reconcileDiscoveryObservation(
        [
          poolDevice(first.deviceId, "Pixel_9_API_36"),
          poolDevice(second.deviceId, "Pixel_8_API_36"),
        ],
        "test:aborted-stale-observation",
        { signal: controller.signal },
      );

      expect(devicePool.isPooledIdentityUnresolved(first.deviceId)).toBe(true);
      expect(devicePool.isPooledIdentityUnresolved(second.deviceId)).toBe(false);
      expect(devicePool.getDevice(second.deviceId)?.sessionId).toBe("unrelated-live-session");
      expect(cancellations).toEqual([]);
    });

    test("keeps a capture live when its failed AVD-name probe recorded the console busy", async () => {
      const cancellations: { sessionId: string; reason: string }[] = [];
      const consoleBusy = new FakeEmulatorConsoleBusyRegistry();
      devicePool = makePool({
        cancelDeviceSessionExecutions: async (sessionId, reason) => {
          cancellations.push({ sessionId, reason });
          return 1;
        },
        consoleBusyRegistry: consoleBusy,
      });
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: "emulator-5554",
        platform: "android",
        sourceImage: androidImage,
      });

      const discovered = {
        ...unresolved("emulator-5554"),
        consoleBusyDuringProbe: true,
      };
      // The save settled after discovery finished but before this reconciliation.
      consoleBusy.setBusy("emulator-5554", false);
      await devicePool.reconcileDiscoveryObservation([discovered], "test:capture");

      expect(cancellations).toEqual([]);
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(false);
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("owner-session");
    });

    test("keeps an unconfirmed live entry and its session when the AVD-name probe timed out", async () => {
      const cancellations: string[] = [];
      devicePool = makePool({
        cancelDeviceSessionExecutions: async (sessionId) => {
          cancellations.push(sessionId);
          return 1;
        },
      });
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
      });
      const pooled = requirePooledDevice(devicePool, device.deviceId);
      expect(pooled.avdName).toBeUndefined();

      await devicePool.reconcileDiscoveryObservation(
        [{ ...unresolved(device.deviceId), nameProbeTimedOut: true }],
        "test:timed-out-probe",
      );

      expect(devicePool.getDevice(device.deviceId)).toBe(pooled);
      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(false);
      expect(cancellations).toEqual([]);
      expect(pooled.sessionId).toBe("owner-session");
      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).not.toThrow();
    });

    test("retains a confirmed identity when rediscovery probes time out during bounded retries", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
        sourceImage: androidImage,
      });
      fakeDeviceManager.bootedDevices = [
        { ...unresolved(device.deviceId), nameProbeTimedOut: true },
      ];
      const getBootedDevicesDetailed =
        fakeDeviceManager.getBootedDevicesDetailed.bind(fakeDeviceManager);
      let retryCalls = 0;
      fakeDeviceManager.getBootedDevicesDetailed = async (platform) => {
        retryCalls++;
        return await getBootedDevicesDetailed(platform);
      };

      await devicePool.reconcileDiscoveryObservation(
        [unresolved(device.deviceId)],
        "test:retry-probe-timed-out",
      );

      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(false);
      expect(retryCalls).toBe(1);
      expect(devicePool.getDevice(device.deviceId)?.identityReconcileAttempts).toBeUndefined();
      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).not.toThrow();

      await devicePool.reconcileDiscoveryObservation(
        fakeDeviceManager.bootedDevices,
        "test:initial-probe-timed-out",
      );
      expect(retryCalls).toBe(1);
      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(false);
    });

    test("retains an existing quarantine when a later AVD-name probe timed out", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation(
        [unresolved(device.deviceId)],
        "test:fast-failed-probe",
      );
      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(true);

      await devicePool.reconcileDiscoveryObservation(
        [{ ...unresolved(device.deviceId), nameProbeTimedOut: true }],
        "test:timed-out-probe",
      );

      expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(true);
    });

    test("quarantines a failed AVD-name probe that recorded the console idle", async () => {
      const consoleBusy = new FakeEmulatorConsoleBusyRegistry();
      devicePool = makePool({ consoleBusyRegistry: consoleBusy });
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      // A later operation can be busy, but it did not cause THIS failed probe.
      consoleBusy.setBusy("emulator-5554", true);

      await devicePool.reconcileDiscoveryObservation(
        [{ ...unresolved("emulator-5554"), consoleBusyDuringProbe: false }],
        "test:idle-probe",
      );

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
    });

    test("retains an existing quarantine when a later failed AVD-name probe recorded the console busy", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);

      await devicePool.reconcileDiscoveryObservation(
        [{ ...unresolved("emulator-5554"), consoleBusyDuringProbe: false }],
        "test:idle-probe",
      );
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);

      await devicePool.reconcileDiscoveryObservation(
        [{ ...unresolved("emulator-5554"), consoleBusyDuringProbe: true }],
        "test:busy-probe",
      );

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
    });

    // The FUNNEL 1 caller can itself be a session-bound destructive call whose
    // own discovery produced the placeholder. Cancelling it would abort the
    // operation that is about to confirm-or-refuse on exactly this evidence, so
    // the discovering execution is exempted while the rest of the session's work
    // is still stopped ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888)
    // review).
    test("exempts the discovering execution from the quarantine cancellation", async () => {
      const cancellations: { sessionId: string; excludeExecutionId?: string }[] = [];
      devicePool = makePool({
        cancelDeviceSessionExecutions: async (sessionId, _reason, options) => {
          cancellations.push({ sessionId, excludeExecutionId: options?.excludeExecutionId });
          return 1;
        },
      });
      await initializeLiveDevices([poolDevice("emulator-5554", "Pixel_8_API_35")]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: "emulator-5554",
        platform: "android",
        sourceImage: androidImage,
      });
      fakeDeviceManager.bootedDevices = [unresolved("emulator-5554")];

      await devicePool.reconcileDiscoveryObservation([unresolved("emulator-5554")], "test:kill", {
        excludeExecutionId: "kill-execution",
      });

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
      expect(cancellations).toEqual([
        { sessionId: "owner-session", excludeExecutionId: "kill-execution" },
      ]);
    });

    test("does not treat an intentionally unenriched placeholder as identity evidence", async () => {
      const cancellations: { sessionId: string }[] = [];
      devicePool = makePool({
        cancelDeviceSessionExecutions: async (sessionId) => {
          cancellations.push({ sessionId });
          return 1;
        },
      });
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: "emulator-5554",
        platform: "android",
        sourceImage: androidImage,
      });

      await devicePool.reconcileDiscoveryObservation(
        [unresolved("emulator-5554")],
        "test:serial-only",
        { namesResolved: false },
      );

      const pooled = devicePool.getDevice("emulator-5554");
      expect(pooled?.identityUnresolved).toBeUndefined();
      expect(pooled?.sessionId).toBe("owner-session");
      expect(cancellations).toEqual([]);
    });

    test("still quarantines a placeholder when name discovery ran", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);

      await devicePool.reconcileDiscoveryObservation(
        [unresolved("emulator-5554")],
        "test:name-aware",
      );

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
    });

    // Concurrent discovery calls finish out of order, so the observation a
    // funnel folds in is not necessarily the newest one. A quarantine entered by
    // the NEWEST evidence must not be lifted by an older listing that happened to
    // land after it: the entry would go back to live — re-admitting tool
    // execution and stream routing — while the newest evidence still says the
    // runtime on that serial is unproven. The pool already orders mutable-name
    // updates by `observedAt`; identity transitions are ordered the same way
    // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    const stamped = (device: BootedDevice, observedAt: number): BootedDevice => ({
      ...device,
      observedAt,
    });

    test("ignores a stale resolved observation that would lift a newer quarantine", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation(
        [stamped(unresolved("emulator-5554"), 7)],
        "test:newest",
      );
      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);

      // The straggler: an older listing that read the AVD name before it became
      // unreadable.
      await devicePool.reconcileDiscoveryObservation([stamped(device, 5)], "test:straggler");

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);

      // Genuinely newer evidence still lifts it.
      await devicePool.reconcileDiscoveryObservation([stamped(device, 9)], "test:newer");

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(false);
    });

    // Re-observing the placeholder advances the evidence the lift is ordered
    // against; otherwise a straggler newer than the FIRST placeholder but older
    // than the latest one would still lift the quarantine.
    test("advances the quarantine's evidence when the placeholder is seen again", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation(
        [stamped(unresolved("emulator-5554"), 3)],
        "test:first",
      );
      await devicePool.reconcileDiscoveryObservation(
        [stamped(unresolved("emulator-5554"), 9)],
        "test:latest",
      );

      await devicePool.reconcileDiscoveryObservation([stamped(device, 5)], "test:straggler");

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
    });

    // The inverse of the stale-lift race: a delayed placeholder must not
    // quarantine an entry whose identity a NEWER observation already resolved.
    // Entering quarantine cancels the bound session's in-flight executions and
    // blocks routing, so acting on stale evidence here is the more destructive
    // half of the ordering bug
    // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    test("ignores a stale placeholder that would quarantine a newer resolved identity", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);

      // The live path records the stamp of the newest resolved observation.
      await devicePool.reconcileDiscoveryObservation([stamped(device, 9)], "test:resolved");

      await devicePool.reconcileDiscoveryObservation(
        [stamped(unresolved("emulator-5554"), 7)],
        "test:straggler",
      );

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(false);
    });

    // Same ordering rule for the disagreement shape: a delayed listing naming a
    // different AVD is not evidence the serial was reused after the newer
    // observation confirmed the pooled one.
    test("ignores a stale disagreeing observation that would quarantine a newer identity", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([stamped(device, 9)], "test:resolved");

      await devicePool.reconcileDiscoveryObservation(
        [stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 7)],
        "test:straggler",
      );

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(false);
    });

    test("ignores a stale liveness disagreement after newer discovery confirmed the pooled identity", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([stamped(device, 10)], "test:resolved");

      // This is the separate assignment-time liveness path. Its discovery
      // started earlier and only completed after the funnel had confirmed A.
      fakeDeviceManager.bootedDevices = [stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 9)];

      await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-1",
        deviceId: "emulator-5554",
        platform: "android",
      });

      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        name: "Pixel_8_API_35",
        sessionId: "session-1",
      });
    });

    test("abandons a liveness replacement made stale while waiting for the assignment mutex", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([stamped(device, 1)], "test:initial");
      const pooled = requirePooledDevice(devicePool, "emulator-5554");

      const internals = devicePool.testHooks;
      const mutexEntered = Promise.withResolvers<void>();
      const releaseMutex = Promise.withResolvers<void>();
      const mutexOwner = internals.assignmentMutex.runExclusive(async () => {
        mutexEntered.resolve();
        await releaseMutex.promise;
      });
      await mutexEntered.promise;

      let replacements = 0;
      const restore_replacePooledDeviceForRuntimeIdentity =
        internals.replacePooledDeviceForRuntimeIdentity.intercept(
          (replacePooledDeviceForRuntimeIdentity) => async (pooledDevice, bootedDevice) => {
            replacements++;
            return await replacePooledDeviceForRuntimeIdentity(pooledDevice, bootedDevice);
          },
        );
      try {
        // The early liveness check accepts stamp 2, then blocks on the mutex.
        const liveness = internals.missingDeviceLiveness.reconcileDiscoveredPooledDevice(
          pooled,
          replacement,
          false,
        );

        // Discovery is intentionally outside the assignment mutex. Its newer
        // confirmation must invalidate the queued liveness replacement.
        await devicePool.reconcileDiscoveryObservation([stamped(device, 3)], "test:newer");
        releaseMutex.resolve();
        await mutexOwner;
        await liveness;

        expect(devicePool.getDevice("emulator-5554")).toBe(pooled);
        expect(replacements).toBe(0);
      } finally {
        restore_replacePooledDeviceForRuntimeIdentity();
        releaseMutex.resolve();
        await mutexOwner;
      }
    });

    test("abandons a liveness replacement made stale during eviction", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([stamped(device, 1)], "test:initial");
      const pooled = requirePooledDevice(devicePool, "emulator-5554");

      const internals = devicePool.testHooks;
      const evictionEntered = Promise.withResolvers<void>();
      const releaseEviction = Promise.withResolvers<void>();
      const resolveMissingDeviceIncident =
        internals.missingDeviceLiveness.resolveMissingDeviceIncident.bind(
          internals.missingDeviceLiveness,
        );
      let adds = 0;
      internals.missingDeviceLiveness.resolveMissingDeviceIncident = async (...args) => {
        // This awaits within eviction before either destructive removal branch,
        // unlike the assignment-mutex gate in the preceding regression test.
        evictionEntered.resolve();
        await releaseEviction.promise;
        return await resolveMissingDeviceIncident(...args);
      };
      const restore_addDevice = internals.addDevice.intercept((addDevice) => async (...args) => {
        adds++;
        return await addDevice(...args);
      });
      try {
        // Stamp 2 passes the liveness replacement's initial stale-observation check.
        const liveness = internals.missingDeviceLiveness.reconcileDiscoveredPooledDevice(
          pooled,
          replacement,
          true,
        );
        await evictionEntered.promise;

        // Discovery reconciliation is intentionally outside assignmentMutex and
        // advances evidence on the same object eviction is still holding.
        await devicePool.reconcileDiscoveryObservation([stamped(device, 3)], "test:newer");
        releaseEviction.resolve();
        await liveness;

        expect(devicePool.getDevice("emulator-5554")).toBe(pooled);
        expect(devicePool.getDevice("emulator-5554")?.name).toBe("Pixel_8_API_35");
        expect(adds).toBe(0);
      } finally {
        internals.missingDeviceLiveness.resolveMissingDeviceIncident = resolveMissingDeviceIncident;
        restore_addDevice();
        releaseEviction.resolve();
      }
    });

    test("abandons an assigned refresh replacement superseded before eviction", async () => {
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
      });
      const pooled = requirePooledDevice(devicePool, device.deviceId);

      const internals = devicePool.testHooks;
      const evictionQueued = Promise.withResolvers<void>();
      const releaseEviction = Promise.withResolvers<void>();
      const sessionReleases: string[] = [];
      const restore_evictMissingPooledDevice = internals.evictMissingPooledDevice.intercept(
        (evictMissingPooledDevice) =>
          async (...args) => {
            evictionQueued.resolve();
            await releaseEviction.promise;
            await evictMissingPooledDevice(...args);
          },
      );
      const restore_releaseSessionForDisconnectedDevice =
        internals.releaseSessionForDisconnectedDevice.intercept(
          (releaseSessionForDisconnectedDevice) =>
            async (sessionId, ...args) => {
              sessionReleases.push(sessionId);
              await releaseSessionForDisconnectedDevice(sessionId, ...args);
            },
        );
      try {
        fakeDeviceManager.bootedDevices = [replacement];
        const refresh = devicePool.refreshDevices();
        await evictionQueued.promise;

        // The refresh chose B at stamp 2, but before its eviction begins a
        // newer discovery proves that A still owns the serial.
        await devicePool.reconcileDiscoveryObservation([stamped(device, 3)], "test:newer");
        releaseEviction.resolve();
        await refresh;

        expect(sessionReleases).toEqual([]);
        expect(devicePool.getDevice(device.deviceId)).toBe(pooled);
        expect(pooled.sessionId).toBe("owner-session");
      } finally {
        restore_evictMissingPooledDevice();
        restore_releaseSessionForDisconnectedDevice();
        releaseEviction.resolve();
      }
    });

    test("re-checks identity at the paused session-release commit", async () => {
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      const releaseEntered = Promise.withResolvers<void>();
      const commitRelease = Promise.withResolvers<void>();
      const sessionReleases: string[] = [];
      devicePool = makePool({
        releaseSessionForDisconnectedDevice: async (sessionId, _deviceId, reason, shouldCommit) => {
          releaseEntered.resolve();
          await commitRelease.promise;
          if (shouldCommit?.() === false) {
            return false;
          }
          sessionReleases.push(sessionId);
          await sessionManager.releaseSession(sessionId, reason);
          return true;
        },
      });
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
      });
      const pooled = requirePooledDevice(devicePool, device.deviceId);

      try {
        fakeDeviceManager.bootedDevices = [replacement];
        const refresh = devicePool.refreshDevices();
        await releaseEntered.promise;

        // The replacement was accepted before release started, but this newer
        // confirmation arrives while the releaser is paused before it commits.
        await devicePool.reconcileDiscoveryObservation([stamped(device, 3)], "test:newer");
        commitRelease.resolve();
        await refresh;

        expect(sessionReleases).toEqual([]);
        expect(devicePool.getDevice(device.deviceId)).toBe(pooled);
        expect(pooled.sessionId).toBe("owner-session");
        expect(sessionManager.getSession("owner-session")).not.toBeNull();
      } finally {
        commitRelease.resolve();
      }
    });

    test("re-checks identity after the default releaser awaits pending session setup (#7031 round 2)", async () => {
      // No custom releaser: the pool's default path hands the fence to
      // SessionManager, whose release first awaits tracked setup work. A newer
      // confirming discovery during that await must keep the session.
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      const setupFinished = Promise.withResolvers<void>();
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      await devicePool.bindOrReuseDeviceSession({
        sessionId: "owner-session",
        deviceId: device.deviceId,
        platform: "android",
      });
      const pooled = devicePool.getDevice(device.deviceId);
      const session = sessionManager.getSession("owner-session");
      if (!pooled || !session) {
        throw new Error("expected pooled device and session");
      }
      const setup = sessionManager.trackSessionSetup(session, () => setupFinished.promise);

      try {
        fakeDeviceManager.bootedDevices = [replacement];
        const refresh = devicePool.refreshDevices();
        // Release refuses new setup once it has begun: a probe that is not
        // admitted proves the eviction is already inside the release, past the
        // pool's early fence, so the newer confirmation below exercises the
        // commit-point fence rather than the up-front one. Only microtasks are
        // yielded, so the wait is deterministic and bounded.
        let releaseBegan = false;
        for (let i = 0; i < 1000 && !releaseBegan; i++) {
          await Promise.resolve();
          releaseBegan = true;
          await sessionManager.trackSessionSetup(session, async () => {
            releaseBegan = false;
          });
        }
        expect(releaseBegan).toBe(true);
        expect(sessionManager.getSession("owner-session")).toBe(session);

        await devicePool.reconcileDiscoveryObservation([stamped(device, 3)], "test:newer");
        setupFinished.resolve();
        await setup;
        await refresh;

        expect(sessionManager.getSession("owner-session")).toBe(session);
        expect(devicePool.getDevice(device.deviceId)).toBe(pooled);
        expect(pooled.sessionId).toBe("owner-session");
      } finally {
        setupFinished.resolve();
      }
    });

    test("uses a newer discovery identity that arrives during replacement cache cleanup", async () => {
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      const newerReplacement = stamped(poolDevice("emulator-5554", "Pixel_6_API_33"), 3);
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      const pooled = requirePooledDevice(devicePool, device.deviceId);

      const internals = devicePool.testHooks;
      const cacheCleanupStarted = Promise.withResolvers<void>();
      const finishCacheCleanup = Promise.withResolvers<void>();
      const restore_clearDeviceSessionCache = internals.clearDeviceSessionCache.intercept(
        (clearDeviceSessionCache) => async (deviceId) => {
          cacheCleanupStarted.resolve();
          await finishCacheCleanup.promise;
          await clearDeviceSessionCache(deviceId);
        },
      );
      try {
        const replacementPromise = internals.replacePooledDeviceForRuntimeIdentity.call(
          pooled,
          replacement,
        );
        await cacheCleanupStarted.promise;
        expect(devicePool.getDevice(device.deviceId)).toBeNull();

        await devicePool.reconcileDiscoveryObservation([newerReplacement], "test:newer");
        finishCacheCleanup.resolve();
        await replacementPromise;

        expect(devicePool.getDevice(device.deviceId)?.name).toBe("Pixel_6_API_33");
      } finally {
        restore_clearDeviceSessionCache();
        finishCacheCleanup.resolve();
      }
    });

    test("ignores raw serial observations but retains failed probes during replacement cleanup", async () => {
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      const installAfterPendingObservation = async (observation: BootedDevice): Promise<void> => {
        const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
        devicePool = makePool();
        await initializeLiveDevices([device]);
        await devicePool.reconcileDiscoveryObservation([device], "test:initial");
        const pooled = requirePooledDevice(devicePool, device.deviceId);
        const internals = devicePool.testHooks;
        const cacheCleanupStarted = Promise.withResolvers<void>();
        const finishCacheCleanup = Promise.withResolvers<void>();
        const restore_clearDeviceSessionCache = internals.clearDeviceSessionCache.intercept(
          (clearDeviceSessionCache) => async (deviceId) => {
            cacheCleanupStarted.resolve();
            await finishCacheCleanup.promise;
            await clearDeviceSessionCache(deviceId);
          },
        );
        try {
          const replacementPromise = internals.replacePooledDeviceForRuntimeIdentity.call(
            pooled,
            replacement,
          );
          await cacheCleanupStarted.promise;
          await devicePool.reconcileDiscoveryObservation([observation], "test:pending");
          finishCacheCleanup.resolve();
          await replacementPromise;
        } finally {
          restore_clearDeviceSessionCache();
          finishCacheCleanup.resolve();
        }
      };

      await installAfterPendingObservation({
        ...replacement,
        name: replacement.deviceId,
        observedAt: 4,
      });
      expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
        name: replacement.name,
        identityObservedAt: 2,
      });
      expect(devicePool.isPooledIdentityUnresolved(replacement.deviceId)).toBe(false);

      await installAfterPendingObservation(stamped(unresolved(replacement.deviceId), 4));
      expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
        name: replacement.name,
        identityObservedAt: 4,
        identityUnresolved: true,
      });
    });

    test("does not let a stale resolved observation outrank newer unresolved replacement evidence", async () => {
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      const unresolvedReplacement = stamped(unresolved("emulator-5554"), 4);
      const resolvedReplacement = stamped(poolDevice("emulator-5554", "Pixel_6_API_33"), 3);
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      const pooled = requirePooledDevice(devicePool, device.deviceId);

      const internals = devicePool.testHooks;
      const cacheCleanupStarted = Promise.withResolvers<void>();
      const finishCacheCleanup = Promise.withResolvers<void>();
      const restore_clearDeviceSessionCache = internals.clearDeviceSessionCache.intercept(
        (clearDeviceSessionCache) => async (deviceId) => {
          cacheCleanupStarted.resolve();
          await finishCacheCleanup.promise;
          await clearDeviceSessionCache(deviceId);
        },
      );
      try {
        const replacementPromise = internals.replacePooledDeviceForRuntimeIdentity.call(
          pooled,
          replacement,
        );
        await cacheCleanupStarted.promise;

        await devicePool.reconcileDiscoveryObservation(
          [unresolvedReplacement],
          "test:unresolved-newer",
        );
        await devicePool.reconcileDiscoveryObservation([resolvedReplacement], "test:resolved");

        expect(
          internals.runtimeIdentity.getPendingUnresolvedEvidence(device.deviceId)?.observedAt,
        ).toBe(4);

        finishCacheCleanup.resolve();
        await replacementPromise;

        const installed = devicePool.getDevice(device.deviceId);
        expect(installed?.name).toBe("Pixel_7_API_34");
        expect(installed?.identityObservedAt).toBe(4);
        expect(installed?.identityUnresolved).toBeTrue();
      } finally {
        restore_clearDeviceSessionCache();
        finishCacheCleanup.resolve();
      }
    });

    test("a timed-out probe during a pending replacement leaves it resolved (#14377)", async () => {
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      const timedOut = { ...stamped(unresolved("emulator-5554"), 4), nameProbeTimedOut: true };
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      const pooled = requirePooledDevice(devicePool, device.deviceId);

      const internals = devicePool.testHooks;
      const cacheCleanupStarted = Promise.withResolvers<void>();
      const finishCacheCleanup = Promise.withResolvers<void>();
      const restore_clearDeviceSessionCache = internals.clearDeviceSessionCache.intercept(
        (clearDeviceSessionCache) => async (deviceId) => {
          cacheCleanupStarted.resolve();
          await finishCacheCleanup.promise;
          await clearDeviceSessionCache(deviceId);
        },
      );
      try {
        const replacementPromise = internals.replacePooledDeviceForRuntimeIdentity.call(
          pooled,
          replacement,
        );
        await cacheCleanupStarted.promise;

        // Host load timed the AVD-name probe out: no identity evidence either way.
        await devicePool.reconcileDiscoveryObservation([timedOut], "test:timed-out");
        expect(
          internals.runtimeIdentity.getPendingUnresolvedEvidence(device.deviceId),
        ).toBeUndefined();

        finishCacheCleanup.resolve();
        await replacementPromise;

        const installed = devicePool.getDevice(device.deviceId);
        expect(installed?.name).toBe("Pixel_7_API_34");
        expect(installed?.identityUnresolved).not.toBeTrue();
      } finally {
        restore_clearDeviceSessionCache();
        finishCacheCleanup.resolve();
      }
    });

    test("lets a later resolved replacement clear pending unresolved evidence", async () => {
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      const unresolvedReplacement = stamped(unresolved("emulator-5554"), 4);
      const resolvedReplacement = stamped(poolDevice("emulator-5554", "Pixel_6_API_33"), 5);
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      const pooled = requirePooledDevice(devicePool, device.deviceId);

      const internals = devicePool.testHooks;
      const cacheCleanupStarted = Promise.withResolvers<void>();
      const finishCacheCleanup = Promise.withResolvers<void>();
      const restore_clearDeviceSessionCache = internals.clearDeviceSessionCache.intercept(
        (clearDeviceSessionCache) => async (deviceId) => {
          cacheCleanupStarted.resolve();
          await finishCacheCleanup.promise;
          await clearDeviceSessionCache(deviceId);
        },
      );
      try {
        const replacementPromise = internals.replacePooledDeviceForRuntimeIdentity.call(
          pooled,
          replacement,
        );
        await cacheCleanupStarted.promise;
        await devicePool.reconcileDiscoveryObservation(
          [unresolvedReplacement],
          "test:unresolved-newer",
        );
        await devicePool.reconcileDiscoveryObservation(
          [resolvedReplacement],
          "test:resolved-newer",
        );
        finishCacheCleanup.resolve();
        await replacementPromise;

        expect(devicePool.getDevice(device.deviceId)).toMatchObject({
          name: "Pixel_6_API_33",
          identityObservedAt: 5,
        });
        expect(devicePool.isPooledIdentityUnresolved(device.deviceId)).toBe(false);
      } finally {
        restore_clearDeviceSessionCache();
        finishCacheCleanup.resolve();
      }
    });

    test("quarantines a replacement when a newer unresolved discovery arrives during cache cleanup", async () => {
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      const unresolvedReplacement = stamped(unresolved("emulator-5554"), 4);
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      const pooled = requirePooledDevice(devicePool, device.deviceId);

      const internals = devicePool.testHooks;
      const cacheCleanupStarted = Promise.withResolvers<void>();
      const finishCacheCleanup = Promise.withResolvers<void>();
      const restore_clearDeviceSessionCache = internals.clearDeviceSessionCache.intercept(
        (clearDeviceSessionCache) => async (deviceId) => {
          cacheCleanupStarted.resolve();
          await finishCacheCleanup.promise;
          await clearDeviceSessionCache(deviceId);
        },
      );
      try {
        const replacementPromise = internals.replacePooledDeviceForRuntimeIdentity.call(
          pooled,
          replacement,
        );
        await cacheCleanupStarted.promise;

        await devicePool.reconcileDiscoveryObservation(
          [unresolvedReplacement],
          "test:unresolved-newer",
        );
        finishCacheCleanup.resolve();
        await replacementPromise;

        const installed = devicePool.getDevice(device.deviceId);
        expect(installed?.name).toBe("Pixel_7_API_34");
        expect(installed?.identityObservedAt).toBe(4);
        expect(installed?.identityUnresolved).toBeTrue();
      } finally {
        restore_clearDeviceSessionCache();
        finishCacheCleanup.resolve();
      }
    });

    test("quarantines an unresolved runtime-identity replacement candidate", async () => {
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const unresolvedReplacement = stamped(unresolved("emulator-5554"), 2);
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      const pooled = requirePooledDevice(devicePool, device.deviceId);

      const internals = devicePool.testHooks;

      await internals.replacePooledDeviceForRuntimeIdentity.call(pooled, unresolvedReplacement);

      expect(devicePool.getDevice(device.deviceId)).toMatchObject({
        name: "Unknown (emulator-5554)",
        identityUnresolved: true,
      });
    });

    test("rejects a stale identity observation while adding a newer replacement", async () => {
      const device = stamped(poolDevice("emulator-5554", "Pixel_8_API_35"), 1);
      const replacement = stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 2);
      const newerReplacement = stamped(poolDevice("emulator-5554", "Pixel_6_API_33"), 5);
      const delayedStraggler = stamped(poolDevice("emulator-5554", "Pixel_5_API_32"), 3);
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      const pooled = requirePooledDevice(devicePool, device.deviceId);

      const internals = devicePool.testHooks;
      const cacheCleanupStarted = Promise.withResolvers<void>();
      const finishCacheCleanup = Promise.withResolvers<void>();
      const sessionTrackingStarted = Promise.withResolvers<void>();
      const finishSessionTracking = Promise.withResolvers<void>();
      let pauseSessionTracking = true;
      const restore_clearDeviceSessionCache = internals.clearDeviceSessionCache.intercept(
        (clearDeviceSessionCache) => async (deviceId) => {
          cacheCleanupStarted.resolve();
          await finishCacheCleanup.promise;
          await clearDeviceSessionCache(deviceId);
        },
      );
      const restore_setDeviceSessionTracking = internals.setDeviceSessionTracking.intercept(
        (setDeviceSessionTracking) => async (deviceId, sessionStart) => {
          if (pauseSessionTracking) {
            pauseSessionTracking = false;
            sessionTrackingStarted.resolve();
            await finishSessionTracking.promise;
          }
          await setDeviceSessionTracking(deviceId, sessionStart);
        },
      );
      try {
        const replacementPromise = internals.replacePooledDeviceForRuntimeIdentity.call(
          pooled,
          replacement,
        );
        await cacheCleanupStarted.promise;
        await devicePool.reconcileDiscoveryObservation([newerReplacement], "test:newer");

        finishCacheCleanup.resolve();
        await sessionTrackingStarted.promise;
        await devicePool.reconcileDiscoveryObservation(
          [delayedStraggler],
          "test:delayed-straggler",
        );

        finishSessionTracking.resolve();
        await replacementPromise;

        const installed = devicePool.getDevice(device.deviceId);
        expect(installed?.name).toBe("Pixel_6_API_33");
        expect(installed?.identityObservedAt).toBe(5);
        expect(installed?.identityUnresolved).toBeUndefined();
      } finally {
        restore_clearDeviceSessionCache();
        restore_setDeviceSessionTracking();
        finishCacheCleanup.resolve();
        finishSessionTracking.resolve();
      }
    });

    test("replaces a pooled identity for a newer liveness disagreement", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([stamped(device, 9)], "test:resolved");
      fakeDeviceManager.bootedDevices = [
        stamped(poolDevice("emulator-5554", "Pixel_7_API_34"), 10),
      ];

      await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-1",
        deviceId: "emulator-5554",
        platform: "android",
      });

      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        name: "Pixel_7_API_34",
        sessionId: "session-1",
      });
    });

    // A placeholder that is genuinely newer than the last resolved observation
    // still quarantines: the ordering rule withholds trust from STALE evidence
    // only.
    test("still quarantines on a placeholder newer than the last resolved observation", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation([stamped(device, 9)], "test:resolved");

      await devicePool.reconcileDiscoveryObservation(
        [stamped(unresolved("emulator-5554"), 11)],
        "test:newer",
      );

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
    });

    // Unstamped observations (start-path snapshots, legacy callers and fakes)
    // cannot be ordered at all, so they keep today's behaviour rather than
    // wedging an entry in quarantine forever.
    test("still lifts the quarantine for an observation with no ordering stamp", async () => {
      const device = poolDevice("emulator-5554", "Pixel_8_API_35");
      await initializeLiveDevices([device]);
      await devicePool.reconcileDiscoveryObservation(
        [stamped(unresolved("emulator-5554"), 7)],
        "test:newest",
      );

      await devicePool.reconcileDiscoveryObservation([device], "test:unstamped");

      expect(devicePool.isPooledIdentityUnresolved("emulator-5554")).toBe(false);
    });

    test("never quarantines a handset, whose name is not its identity", async () => {
      const handset = createBootedDevice("R5CT10ABCDE", "android", "Pixel 8");
      await initializeLiveDevices([handset]);

      await refreshWith([createBootedDevice("R5CT10ABCDE", "android", "Unknown (R5CT10ABCDE)")]);

      expect(devicePool.isPooledIdentityUnresolved("R5CT10ABCDE")).toBe(false);
    });
  });
});
