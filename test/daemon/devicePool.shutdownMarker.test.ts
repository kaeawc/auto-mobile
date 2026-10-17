import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { BootedDevice, DeviceInfo } from "../../src/models";

import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  DeferredDiscoveryFakeDeviceManager,
  OutOfOrderRefreshFakeDeviceManager,
  TransportAwareFakeDeviceManager,
  createBootedDevice,
  createDevicePoolSuite,
  devicePoolSuiteActions,
  enableRebootOnDeath,
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

  describe("intentional-shutdown marker incarnation scoping", () => {
    const androidImage = {
      name: "Pixel 8",
      platform: "android" as const,
      isRunning: false,
      source: "local" as const,
    };

    const withRebootOnDeath = async (run: () => Promise<void>): Promise<void> => {
      const restore = enableRebootOnDeath();
      try {
        await run();
      } finally {
        restore();
      }
    };

    test("a stale disconnect does not remove an intentionally-stopped device that is still booted", async () => {
      await withRebootOnDeath(async () => {
        devicePool = makePool({ recoveryPolicy: { onLoss: true, maxAttempts: 2 } });
        await devicePool.addDevice(
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
          androidImage,
        );
        devicePool.markIntentionalShutdown("emulator-5554");
        // The serial is still booted — the kill has not taken effect yet, or a
        // same-serial device is already back. The disconnect signal is stale.
        fakeDeviceManager.bootedDevices = [
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
        ];

        await devicePool.removeDisconnectedDevice("emulator-5554", true);

        // Before the fix the marker was consumed before the rediscovery check, so
        // this live device would be removed.
        expect(devicePool.getDevice("emulator-5554")).not.toBeNull();

        // A genuine disconnect (the serial is truly gone) still honors the mark.
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice("emulator-5554", true);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      });
    });

    test("does not remove a same-serial replacement that swaps in during the rediscovery await", async () => {
      await withRebootOnDeath(async () => {
        const deferred = new DeferredDiscoveryFakeDeviceManager();
        fakeDeviceManager = deferred;
        devicePool = makePool({
          deviceManager: deferred,
          recoveryPolicy: { onLoss: true, maxAttempts: 2 },
        });
        await devicePool.addDevice(
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
          androidImage,
        );
        devicePool.markIntentionalShutdown("emulator-5554");
        // Discovery will find nothing, so without a post-await identity re-check
        // the disconnect would fall through to consume + remove.
        deferred.bootedDevices = [];

        // Start the disconnect; it blocks inside the rediscovery discovery await.
        const disconnect = devicePool.removeDisconnectedDevice("emulator-5554", true);
        await deferred.waitForDiscoveryStart();

        // While the await is in flight, the marked incarnation leaves and a fresh
        // same-serial incarnation (with its own marker) takes its place.
        await devicePool.removeDevice("emulator-5554");
        await devicePool.addDevice(
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
          androidImage,
        );
        devicePool.markIntentionalShutdown("emulator-5554");
        const replacement = devicePool.getDevice("emulator-5554");
        if (!replacement) {
          throw new Error("expected replacement device");
        }

        deferred.releaseDiscovery();
        await disconnect;

        // The stale disconnect for the prior incarnation must not delete the live
        // replacement (nor consume its newly set marker).
        const afterDisconnect = devicePool.getDevice("emulator-5554");
        expect(afterDisconnect).not.toBeNull();
        expect(afterDisconnect!.incarnation).toBe(replacement.incarnation);
      });
    });

    test("assigns a fresh incarnation per pooled connection and keeps it across a rediscovery", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await initializeLiveDevices([device]);
      const first = requirePooledDevice(devicePool, "emulator-5554");
      const firstIncarnation = first.incarnation;

      // A refresh that rediscovers the same serial reuses the entry — same
      // incarnation, so an existing mark for it still applies.
      await devicePool.refreshDevices();
      expect(devicePool.getDevice("emulator-5554")?.incarnation).toBe(firstIncarnation);

      // Once the serial leaves and re-appears, it is a new connection and gets a
      // fresh incarnation, so a mark from the prior incarnation cannot match it.
      await devicePool.removeDevice("emulator-5554");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.refreshDevices();
      const second = devicePool.getDevice("emulator-5554");
      expect(second).not.toBeNull();
      expect(second!.incarnation).toBeGreaterThan(firstIncarnation);
    });

    test("mints a new device session epoch when a serial disappears and returns", async () => {
      const registry = new DeviceSessionRegistry(
        fakeTimer,
        new FakeIdGenerator(["uuid-a", "uuid-b"]),
      );
      const transportAwareDeviceManager = new TransportAwareFakeDeviceManager();
      fakeDeviceManager = transportAwareDeviceManager;
      devicePool = makePool({
        onDeviceReady: (deviceId) => {
          const pooled = devicePool.getDevice(deviceId);
          if (pooled) {
            registry.onDeviceConnected({
              deviceId: pooled.id,
              platform: pooled.platform,
              incarnation: pooled.incarnation,
            });
          }
        },
        onDeviceRemoved: (deviceId) => registry.onDeviceDisconnected(deviceId),
      });
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      await initializeLiveDevices([firstConnection]);
      devicePool.notifyDeviceReady(firstConnection.deviceId);
      const firstEpoch = registry.getByDeviceId(firstConnection.deviceId);
      const firstIncarnation = devicePool.getDevice(firstConnection.deviceId)?.incarnation;
      if (!firstEpoch || firstIncarnation === undefined) {
        throw new Error("expected the first pooled connection epoch");
      }

      // The pool observing the serial leave is the epoch boundary; the serial
      // returning afterwards is a new incarnation even though adb reports the
      // identical listing.
      await devicePool.removeDevice(firstConnection.deviceId);
      fakeDeviceManager.bootedDevices = [reconnected];

      const added = await devicePool.refreshDevices();

      const secondEpoch = registry.getByDeviceId(reconnected.deviceId);
      expect(added).toBe(1);
      expect(devicePool.getDevice(reconnected.deviceId)?.incarnation).toBeGreaterThan(
        firstIncarnation,
      );
      expect(secondEpoch?.deviceSessionUuid).toBe("uuid-b");
      expect(secondEpoch?.deviceSessionUuid).not.toBe(firstEpoch.deviceSessionUuid);
      expect(registry.getByUuid(firstEpoch.deviceSessionUuid)).toBeUndefined();
      expect(transportAwareDeviceManager.discoveryOptions).toEqual([
        { bypassAndroidDeviceListCache: true, bypassIosDeviceListCache: true },
      ]);
    });

    test("rekeys a same-serial AVD replacement before assigning an idle device", async () => {
      const registry = new DeviceSessionRegistry(
        fakeTimer,
        new FakeIdGenerator(["uuid-a", "uuid-b"]),
      );
      fakeDeviceManager = new TransportAwareFakeDeviceManager();
      devicePool = makePool({
        onDeviceReady: (deviceId) => {
          const pooled = devicePool.getDevice(deviceId);
          if (pooled) {
            registry.onDeviceConnected({
              deviceId: pooled.id,
              platform: pooled.platform,
              incarnation: pooled.incarnation,
            });
          }
        },
        onDeviceRemoved: (deviceId) => registry.onDeviceDisconnected(deviceId),
      });
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection, name: "Pixel 9" };
      await initializeLiveDevices([firstConnection]);
      devicePool.notifyDeviceReady(firstConnection.deviceId);
      const firstEpoch = registry.getByDeviceId(firstConnection.deviceId);
      fakeDeviceManager.bootedDevices = [reconnected];

      await expect(devicePool.assignDeviceToSession("session-1", "android")).resolves.toBe(
        reconnected.deviceId,
      );

      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        name: "Pixel 9",
        sessionId: "session-1",
      });
      expect(registry.getByDeviceId(reconnected.deviceId)?.deviceSessionUuid).toBe("uuid-b");
      expect(registry.getByUuid(firstEpoch!.deviceSessionUuid)).toBeUndefined();
    });

    test("discards an older refresh snapshot after a newer same-serial replacement", async () => {
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection, name: "Pixel 9" };
      const outOfOrderManager = new OutOfOrderRefreshFakeDeviceManager(
        [firstConnection],
        [reconnected],
      );
      fakeDeviceManager = outOfOrderManager;
      devicePool = makePool();
      await initializeLiveDevices([firstConnection]);

      const olderRefresh = devicePool.refreshDevices();
      await outOfOrderManager.waitForFirstDiscoveryStart();
      await devicePool.refreshDevices();
      outOfOrderManager.releaseFirstDiscovery();
      await olderRefresh;

      expect(devicePool.getDevice(reconnected.deviceId)?.name).toBe("Pixel 9");
    });

    test("preserves AutoMobile-owned emulator metadata across a same-serial rediscovery", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      await devicePool.addDevice(firstConnection, sourceImage);
      const incarnation = devicePool.getDevice(firstConnection.deviceId)?.incarnation;
      fakeDeviceManager.bootedDevices = [reconnected];

      await devicePool.refreshDevices();

      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        incarnation,
        avdName: "Pixel 8",
        androidImage: sourceImage,
      });
    });

    test("does not transfer AutoMobile-owned metadata to a different AVD with the same serial", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const replacement = { ...firstConnection, name: "Pixel 9" };
      await devicePool.addDevice(firstConnection, sourceImage);
      fakeDeviceManager.bootedDevices = [replacement];

      await devicePool.refreshDevices();

      expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({ name: "Pixel 9" });
      expect(devicePool.getDevice(replacement.deviceId)?.androidImage).toBeUndefined();
      expect(devicePool.getDevice(replacement.deviceId)?.avdName).toBeUndefined();
    });

    test("keeps AutoMobile-owned metadata when emulator name discovery is unknown", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const rediscoveredWithUnknownName = {
        ...firstConnection,
        name: "Unknown (emulator-5554)",
      };
      await devicePool.addDevice(firstConnection, sourceImage);
      const incarnation = devicePool.getDevice(firstConnection.deviceId)?.incarnation;
      fakeDeviceManager.bootedDevices = [rediscoveredWithUnknownName];

      await devicePool.refreshDevices();

      // The placeholder asserts nothing, so it neither evicts the live entry,
      // starts a new epoch, nor overwrites the known AVD label.
      expect(devicePool.getDevice(firstConnection.deviceId)).toMatchObject({
        name: "Pixel 8",
        incarnation,
        androidImage: sourceImage,
        avdName: "Pixel 8",
      });
    });

    // `Unknown (<serial>)` asserts nothing, so it is neither evidence that a
    // different AVD took the serial (the entry survives) nor evidence that the
    // pooled entry describes what is running now (#6863 review). Consumers that
    // publish pool-derived epoch information must therefore not treat it as a
    // match.
    test("does not claim a pooled entry describes a placeholder-named runtime", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await devicePool.addDevice(firstConnection, sourceImage);

      expect(devicePool.describesPooledRuntime(firstConnection)).toBe(true);
      expect(
        devicePool.describesPooledRuntime({
          ...firstConnection,
          name: "Unknown (emulator-5554)",
        }),
      ).toBe(false);
      // The entry itself is untouched: the placeholder is not a replacement.
      expect(devicePool.getDevice(firstConnection.deviceId)).toMatchObject({ name: "Pixel 8" });
    });

    test("does not transfer ownership from an unknown-name emulator to a different known AVD", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const rediscoveredWithUnknownName = {
        ...firstConnection,
        name: "Unknown (emulator-5554)",
      };
      const differentAvd = { ...firstConnection, name: "Pixel 9" };
      await devicePool.addDevice(firstConnection, sourceImage);
      fakeDeviceManager.bootedDevices = [rediscoveredWithUnknownName];
      await devicePool.refreshDevices();
      fakeDeviceManager.bootedDevices = [differentAvd];

      await devicePool.refreshDevices();

      expect(devicePool.getDevice(differentAvd.deviceId)).toMatchObject({ name: "Pixel 9" });
      expect(devicePool.getDevice(differentAvd.deviceId)?.androidImage).toBeUndefined();
      expect(devicePool.getDevice(differentAvd.deviceId)?.avdName).toBeUndefined();
    });

    test("reserves startDevice readiness for a runtime whose AVD name could not be read", async () => {
      const firstConnection = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const unreadable = { ...firstConnection, name: "Unknown (emulator-5554)" };
      await initializeLiveDevices([firstConnection]);
      const incarnation = devicePool.getDevice(firstConnection.deviceId)?.incarnation;

      const releaseReservation = await devicePool.reserveDeviceForReadiness(
        unreadable.deviceId,
        unreadable,
      );

      // The placeholder must not read as an identity mismatch, and must not
      // evict the entry whose readiness is being reserved.
      expect(devicePool.getDevice(firstConnection.deviceId)).toMatchObject({
        name: "Pixel 8",
        incarnation,
      });
      await releaseReservation();
    });

    test("allocates a rediscovered handset on its unique serial alone", async () => {
      const firstConnection = createBootedDevice("R5CT123456", "android", "Pixel 8");
      const reconnected = { ...firstConnection };
      await initializeLiveDevices([firstConnection]);
      const incarnation = devicePool.getDevice(firstConnection.deviceId)?.incarnation;
      fakeDeviceManager.bootedDevices = [reconnected];

      await expect(devicePool.assignDeviceToSession("session-usb", "android")).resolves.toBe(
        reconnected.deviceId,
      );

      // A handset serial is never reassigned, so rediscovery is continuity.
      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        incarnation,
        sessionId: "session-usb",
      });
    });

    test("does not hide same-model physical Android devices behind an AVD reservation", async () => {
      const firstPhone = createBootedDevice("R5CT123456", "android", "Pixel 8");
      const secondPhone = createBootedDevice("R5CT654321", "android", "Pixel 8");
      await initializeLiveDevices([firstPhone, secondPhone]);
      const releaseReservation = await devicePool.reserveDeviceForReadiness(
        firstPhone.deviceId,
        firstPhone,
        "Pixel 8",
        "Pixel 8",
      );

      try {
        await expect(
          devicePool.assignDeviceToSession("second-phone-session", "android"),
        ).resolves.toBe(secondPhone.deviceId);
      } finally {
        await releaseReservation();
      }
    });

    test("adopts the started AVD name once discovery replaces the unknown-name placeholder", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const started = createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)");
      await devicePool.addDevice(started, sourceImage);
      const incarnation = devicePool.getDevice(started.deviceId)?.incarnation;
      fakeDeviceManager.bootedDevices = [{ ...started, name: "Pixel 8" }];

      await devicePool.refreshDevices();

      expect(devicePool.getDevice(started.deviceId)).toMatchObject({
        name: "Pixel 8",
        avdName: "Pixel 8",
        incarnation,
      });
    });

    test("does not adopt a resolved name that contradicts the AVD this pool started", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const started = createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)");
      await devicePool.addDevice(started, sourceImage);
      const incarnation = devicePool.getDevice(started.deviceId)?.incarnation;
      fakeDeviceManager.bootedDevices = [{ ...started, name: "Pixel 9" }];

      await devicePool.refreshDevices();

      const replaced = devicePool.getDevice(started.deviceId);
      expect(replaced?.name).toBe("Pixel 9");
      expect(replaced?.incarnation).not.toBe(incarnation);
      expect(replaced?.androidImage).toBeUndefined();
      expect(replaced?.avdName).toBeUndefined();
    });

    // #10603: an already-running emulator discovered while its console could not
    // answer `avd name` is pooled as the placeholder with no `avdName`. Nothing
    // a later resolved name could contradict, so the pool must adopt it rather
    // than keep the serial unacquirable until a daemon restart.
    test("adopts a resolved name for a discovered emulator pooled under the placeholder", async () => {
      const placeholder = createBootedDevice("emulator-5600", "android", "Unknown (emulator-5600)");
      fakeDeviceManager.bootedDevices = [placeholder];
      await devicePool.refreshDevices();
      const pooled = devicePool.getDevice(placeholder.deviceId);
      expect(pooled).toMatchObject({ name: "Unknown (emulator-5600)" });
      expect(pooled?.avdName).toBeUndefined();
      const incarnation = pooled?.incarnation;
      const resolved = { ...placeholder, name: "am-api36-ga-arm64" };
      expect(devicePool.matchesRuntimeIdentity(pooled!, resolved)).toBe(true);

      fakeDeviceManager.bootedDevices = [resolved];
      await devicePool.refreshDevices();

      const upgraded = devicePool.getDevice(placeholder.deviceId);
      expect(upgraded).toBe(pooled);
      expect(upgraded).toMatchObject({ name: "am-api36-ga-arm64", incarnation });
      expect(upgraded?.identityUnresolved).toBeUndefined();
      expect(devicePool.describesPooledRuntime(resolved)).toBe(true);
    });

    test("upgrades a discovered placeholder through the discovery funnel too", async () => {
      const placeholder = createBootedDevice("emulator-5600", "android", "Unknown (emulator-5600)");
      fakeDeviceManager.bootedDevices = [placeholder];
      await devicePool.refreshDevices();
      const incarnation = devicePool.getDevice(placeholder.deviceId)?.incarnation;

      await devicePool.reconcileDiscoveryObservation(
        [{ ...placeholder, name: "am-api36-ga-arm64" }],
        "test",
      );

      expect(devicePool.getDevice(placeholder.deviceId)).toMatchObject({
        name: "am-api36-ga-arm64",
        incarnation,
      });
      expect(devicePool.isPooledIdentityUnresolved(placeholder.deviceId)).toBe(false);
    });

    // Assignment refuses a quarantined placeholder, so a placeholder-named entry
    // that holds a session cannot be built through the public API; seed the
    // session on the discovered, quarantined entry directly.
    const holdSessionThenLosePlaceholderName = async (placeholder: BootedDevice) => {
      fakeDeviceManager.bootedDevices = [placeholder];
      await devicePool.refreshDevices();
      const pooled = devicePool.getDevice(placeholder.deviceId)!;
      pooled.sessionId = "held-session";
      pooled.status = "busy";
    };

    test("upgrades a quarantined placeholder that holds a session without rebinding it", async () => {
      const placeholder = createBootedDevice("emulator-5600", "android", "Unknown (emulator-5600)");
      await holdSessionThenLosePlaceholderName(placeholder);
      const before = devicePool.getDevice(placeholder.deviceId)!;
      const incarnation = before.incarnation;
      expect(before.sessionId).toBe("held-session");
      expect(before.avdName).toBeUndefined();
      expect(devicePool.isPooledIdentityUnresolved(placeholder.deviceId)).toBe(true);

      await devicePool.reconcileDiscoveryObservation(
        [{ ...placeholder, name: "am-api36-ga-arm64" }],
        "test",
      );

      const after = devicePool.getDevice(placeholder.deviceId);
      expect(after).toBe(before);
      expect(after).toMatchObject({
        name: "am-api36-ga-arm64",
        incarnation,
        sessionId: "held-session",
      });
      expect(devicePool.isPooledIdentityUnresolved(placeholder.deviceId)).toBe(false);
    });

    test("does not tolerate a resolved name for a retired placeholder incarnation that held a session", async () => {
      const placeholder = createBootedDevice("emulator-5600", "android", "Unknown (emulator-5600)");
      const resolved = { ...placeholder, name: "am-api36-ga-arm64" };
      await holdSessionThenLosePlaceholderName(placeholder);
      const pooled = devicePool.getDevice(placeholder.deviceId)!;
      // Snapshot of the session-holding incarnation, then retire it the way the
      // pool does: the session ends, the entry goes, a new one takes the serial.
      const retired = { ...pooled };
      expect(retired.sessionId).toBe("held-session");
      pooled.sessionId = null;
      pooled.status = "idle";
      await devicePool.removeDevice(placeholder.deviceId);
      await devicePool.refreshDevices();
      const current = devicePool.getDevice(placeholder.deviceId)!;

      expect(current.incarnation).toBeGreaterThan(retired.incarnation);
      expect(devicePool.matchesRuntimeIdentity(retired, resolved)).toBe(false);
      expect(devicePool.matchesRuntimeIdentity(current, resolved)).toBe(true);
    });

    test("does not tolerate a resolved name for a retired placeholder incarnation", async () => {
      const placeholder = createBootedDevice("emulator-5600", "android", "Unknown (emulator-5600)");
      const resolved = { ...placeholder, name: "am-api36-ga-arm64" };
      fakeDeviceManager.bootedDevices = [placeholder];
      await devicePool.refreshDevices();
      const retired = devicePool.getDevice(placeholder.deviceId)!;

      await devicePool.removeDevice(placeholder.deviceId);
      await devicePool.refreshDevices();
      const current = devicePool.getDevice(placeholder.deviceId)!;

      expect(current.incarnation).toBeGreaterThan(retired.incarnation);
      expect(devicePool.matchesRuntimeIdentity(retired, resolved)).toBe(false);
      expect(devicePool.matchesRuntimeIdentity(current, resolved)).toBe(true);
    });

    test("documented blind spot: a same-serial restart inside one discovery interval keeps its incarnation", async () => {
      // Without a discovery-level epoch token there is nothing in an adb
      // listing that distinguishes "still the same emulator process" from "the
      // same AVD restarted between two discovery sweeps". The pool never
      // observed the disappearance, so the incarnation — the only epoch token
      // left — is unchanged, and every cache keyed on it must self-heal on use
      // rather than rely on invalidation. Asserted here so the gap stays
      // deliberate instead of becoming a surprise.
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await initializeLiveDevices([device]);
      const incarnation = devicePool.getDevice(device.deviceId)?.incarnation;

      fakeDeviceManager.bootedDevices = [{ ...device }];
      await devicePool.refreshDevices();

      expect(devicePool.getDevice(device.deviceId)?.incarnation).toBe(incarnation);
    });

    test("starts a new incarnation once the serial is observed to disappear and return", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await initializeLiveDevices([device]);
      const incarnation = devicePool.getDevice(device.deviceId)?.incarnation;

      await devicePool.removeDevice(device.deviceId);
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.refreshDevices();

      expect(devicePool.getDevice(device.deviceId)?.incarnation).toBeGreaterThan(incarnation!);
    });

    test("never conflates two same-model handsets that share a display name", async () => {
      const firstPhone = createBootedDevice("R5CT123456", "android", "Pixel 8");
      const secondPhone = createBootedDevice("R5CT654321", "android", "Pixel 8");
      await initializeLiveDevices([firstPhone, secondPhone]);
      const firstIncarnation = devicePool.getDevice(firstPhone.deviceId)?.incarnation;
      const secondIncarnation = devicePool.getDevice(secondPhone.deviceId)?.incarnation;

      // Handset names are `ro.product.model` and are not unique, so identity
      // for a non-emulator serial stays serial-only.
      expect(firstIncarnation).not.toBe(secondIncarnation);
      await devicePool.removeDevice(firstPhone.deviceId);
      fakeDeviceManager.bootedDevices = [secondPhone];
      await devicePool.refreshDevices();

      expect(devicePool.getDevice(firstPhone.deviceId)).toBeNull();
      expect(devicePool.getDevice(secondPhone.deviceId)?.incarnation).toBe(secondIncarnation);
    });

    test("reserves a verified AVD name when the running emulator lacks AVD metadata", async () => {
      const original = createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      await initializeLiveDevices([original, replacement]);
      const releaseReservation = await devicePool.reserveDeviceForReadiness(
        original.deviceId,
        original,
        sourceImage.name,
        sourceImage.name,
      );

      try {
        expect(devicePool.getIdleDevices().map((device) => device.id)).not.toContain(
          replacement.deviceId,
        );
      } finally {
        await releaseReservation();
      }
    });

    test("rejects direct binding to an AVD reserved for recovery readiness", async () => {
      const original = createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      await initializeLiveDevices([original, replacement]);
      const releaseReservation = await devicePool.reserveDeviceForReadiness(
        original.deviceId,
        original,
        sourceImage.name,
        sourceImage.name,
      );

      try {
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "competing-session",
            replacement.deviceId,
            "android",
            sourceImage,
          ),
        ).rejects.toThrow("not available");
        expect(sessionManager.getSession("competing-session")).toBeNull();
      } finally {
        await releaseReservation();
      }
    });

    test("allows the readiness reservation owner to bind its recovered AVD", async () => {
      const original = createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      await initializeLiveDevices([original, replacement]);
      const reservation = await devicePool.reserveDeviceForReadiness(
        original.deviceId,
        original,
        sourceImage.name,
        sourceImage.name,
      );

      try {
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "recovery-session",
            replacement.deviceId,
            "android",
            sourceImage,
            undefined,
            undefined,
            false,
            new Set([reservation.owner]),
          ),
        ).resolves.toBe("recovery-session");
        expect(sessionManager.getSession("recovery-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
      } finally {
        await reservation();
      }
    });

    test("keeps a same-serial recovery replacement reserved for its readiness owner", async () => {
      const original = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [original];
      await devicePool.addDevice(original, sourceImage);
      const reservation = await devicePool.reserveDeviceForReadiness(
        original.deviceId,
        original,
        sourceImage.name,
      );
      const originalIncarnation = devicePool.getDevice(original.deviceId)?.incarnation;

      await devicePool.removeDevice(original.deviceId);
      const replacement = { ...original };
      fakeDeviceManager.bootedDevices = [replacement];
      await devicePool.addDevice(replacement, sourceImage);

      try {
        expect(devicePool.getDevice(replacement.deviceId)?.incarnation).not.toBe(
          originalIncarnation,
        );
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "competing-session",
            replacement.deviceId,
            "android",
            sourceImage,
          ),
        ).rejects.toThrow("not available");
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "recovery-session",
            replacement.deviceId,
            "android",
            sourceImage,
            undefined,
            undefined,
            false,
            new Set([reservation.owner]),
          ),
        ).resolves.toBe("recovery-session");
        expect(sessionManager.getSession("competing-session")).toBeNull();
        expect(sessionManager.getSession("recovery-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
      } finally {
        await reservation();
      }
    });

    test("allows concurrent readiness owners to reuse their exact same AVD", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.addDevice(device, sourceImage);
      const firstReservation = await devicePool.reserveDeviceForReadiness(
        device.deviceId,
        device,
        sourceImage.name,
      );
      const secondReservation = await devicePool.reserveDeviceForReadiness(
        device.deviceId,
        device,
        sourceImage.name,
      );

      try {
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "first-session",
            device.deviceId,
            "android",
            undefined,
            undefined,
            device,
            false,
            new Set([firstReservation.owner]),
          ),
        ).resolves.toBe("first-session");
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "second-session",
            device.deviceId,
            "android",
            undefined,
            undefined,
            device,
            false,
            new Set([secondReservation.owner]),
          ),
        ).resolves.toBe("first-session");
      } finally {
        await firstReservation();
        await secondReservation();
      }
    });
  });
});
