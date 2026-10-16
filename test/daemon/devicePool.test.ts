import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { BootedDevice, DeviceInfo } from "../../src/models";

import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  DeferredDeviceSessionPersistence,
  DeferredDiscoveryFakeDeviceManager,
  ThrowingDiscoveryFakeDeviceManager,
  androidDeviceImage,
  createBootedDevice,
  createDevicePoolSuite,
  devicePoolSuiteActions,
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

  test("reports recovering Android names and serials from tracked recovery state", () => {
    const recoveringImage = {
      name: "Pixel_8_API_35",
      platform: "android" as const,
      isRunning: false,
      deviceId: "emulator-5554",
    };
    const internals = devicePool as unknown as {
      recoveringAndroidImages: Map<string, DeviceInfo>;
      recoveringAndroidDeviceIds: Set<string>;
    };
    internals.recoveringAndroidImages.set(recoveringImage.name, recoveringImage);
    internals.recoveringAndroidDeviceIds.add("emulator-5556");

    expect(devicePool.getRecoveringAndroidTargets()).toEqual({
      names: new Set([recoveringImage.name]),
      serials: new Set([recoveringImage.deviceId, "emulator-5556"]),
    });
  });

  test("rejects an unpooled Unknown Android replacement whose serial is recovering", async () => {
    const recoveringImage: DeviceInfo = androidDeviceImage("Pixel_8_API_35", "emulator-5556");
    (
      devicePool as unknown as { recoveringAndroidImages: Map<string, DeviceInfo> }
    ).recoveringAndroidImages.set(recoveringImage.name, recoveringImage);
    const replacement: BootedDevice = {
      name: "Unknown (emulator-5556)",
      platform: "android",
      deviceId: "emulator-5556",
    };

    await expect(
      devicePool.reserveDeviceForReadiness(
        replacement.deviceId,
        replacement,
        recoveringImage.name,
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow("entered recovery while awaiting its readiness reservation");
  });

  test("accepts an unpooled resolved Android replacement with a recycled recovering serial", async () => {
    const recoveringImage: DeviceInfo = androidDeviceImage("Pixel_7", "emulator-5556");
    (
      devicePool as unknown as { recoveringAndroidImages: Map<string, DeviceInfo> }
    ).recoveringAndroidImages.set(recoveringImage.name, recoveringImage);
    const replacement: BootedDevice = {
      name: "Pixel_8",
      platform: "android",
      deviceId: "emulator-5556",
    };

    const release = await devicePool.reserveDeviceForReadiness(
      replacement.deviceId,
      replacement,
      replacement.name,
      undefined,
      undefined,
      true,
    );

    await release();
  });

  test("fences readiness side effects to the MCP session that owns a non-autolocked device", async () => {
    const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
    await initializeLiveDevices([device]);
    await devicePool.bindOrReuseDeviceSession(
      "owner-session",
      device.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      "owner-mcp-session",
    );

    await expect(
      devicePool.reserveDeviceForReadiness(device.deviceId, device, device.name, undefined, {
        mcpSessionId: "other-mcp-session",
      }),
    ).rejects.toMatchObject({
      // Typed so the JUnit held-device wait and the CLI hint recognize it (#11071).
      code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      message: expect.stringContaining("already assigned to another session"),
    });

    const release = await devicePool.reserveDeviceForReadiness(
      device.deviceId,
      device,
      device.name,
      undefined,
      { mcpSessionId: "owner-mcp-session" },
    );
    await release();
  });

  test("reuses a freshly started device already owned by the same MCP session", async () => {
    const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
    const sourceImage: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      isRunning: false,
      source: "local",
    };
    await initializeLiveDevices([device]);
    await devicePool.bindOrReuseDeviceSession(
      "owner-session",
      device.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      "owner-mcp-session",
    );

    await expect(
      devicePool.bindOrReuseDeviceSession(
        "newly-generated-session",
        device.deviceId,
        "android",
        sourceImage,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        "owner-mcp-session",
      ),
    ).resolves.toBe("owner-session");
    expect(devicePool.getDevice(device.deviceId)?.assignmentCount).toBe(1);
  });

  test("rejects a freshly started device owned by a different MCP session", async () => {
    const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
    const sourceImage: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      isRunning: false,
      source: "local",
    };
    await initializeLiveDevices([device]);
    await devicePool.bindOrReuseDeviceSession(
      "owner-session",
      device.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      "owner-mcp-session",
    );

    await expect(
      devicePool.bindOrReuseDeviceSession(
        "newly-generated-session",
        device.deviceId,
        "android",
        sourceImage,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        "other-mcp-session",
      ),
    ).rejects.toThrow("already assigned to another session");
    expect(devicePool.getDevice(device.deviceId)?.sessionId).toBe("owner-session");
  });

  test("rejects an anonymous re-acquisition of a freshly started device", async () => {
    const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
    const sourceImage: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      isRunning: false,
      source: "local",
    };
    await initializeLiveDevices([device]);
    await devicePool.bindOrReuseDeviceSession(
      "owner-session",
      device.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      "owner-mcp-session",
    );

    await expect(
      devicePool.bindOrReuseDeviceSession(
        "newly-generated-session",
        device.deviceId,
        "android",
        sourceImage,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(
      "Freshly started device 'emulator-5554' was assigned to session " +
        "owner-session before its owning session could reserve it.",
    );
    expect(devicePool.getDevice(device.deviceId)?.sessionId).toBe("owner-session");
  });

  test("names a restored session awaiting its owner instead of a fresh-start race (#11189)", async () => {
    const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
    const sourceImage: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      isRunning: false,
      source: "local",
    };
    await initializeLiveDevices([device]);
    await devicePool.bindOrReuseDeviceSession(
      "restored-session",
      device.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      "owner-mcp-session",
    );
    // What startup rehydration leaves behind after a daemon restart.
    sessionManager.getSession("restored-session")!.ownership = "awaiting-owner";

    const refusal = devicePool.bindOrReuseDeviceSession(
      "newly-generated-session",
      device.deviceId,
      "android",
      sourceImage,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
    );
    await expect(refusal).rejects.toThrow(
      "Device 'emulator-5554' is reserved for session restored-session, which the daemon " +
        "restored after a restart and is holding for its previous owner to reconnect.",
    );
    await expect(refusal).rejects.not.toThrow("Freshly started");
    expect(devicePool.getDevice(device.deviceId)?.sessionId).toBe("restored-session");
  });

  describe("assertSessionReadyForAutomation shutdown admission (#5494)", () => {
    const sourceImage: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      isRunning: false,
      source: "local",
    };

    const bindOwnerSession = async (sessionId: string, deviceId: string): Promise<void> => {
      const device = createBootedDevice(deviceId, "android", "Pixel 8");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(sessionId, deviceId, "android", sourceImage);
      expect(sessionManager.getSession(sessionId)?.assignedDevice).toBe(deviceId);
    };

    test("rejects a bound session while its device holds a shutdown reservation", async () => {
      await bindOwnerSession("owner-session", "emulator-5554");

      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).not.toThrow();

      const reservation = await devicePool.reserveDeviceForShutdown("emulator-5554");
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }
      try {
        expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).toThrow(
          /shutting down/,
        );
      } finally {
        await reservation.release();
      }

      // Retirement releases the reservation, so admission resumes.
      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).not.toThrow();
    });

    test("does not allocate a live marked incarnation after a timed-out kill releases its reservation", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await initializeLiveDevices([device]);
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected pooled shutdown device");
      }
      devicePool.markIntentionalShutdown(device.deviceId);
      const reservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }
      await reservation.release();

      // The platform command is still unsettled. A booted observation alone
      // cannot remove its late-exit fence or hand the device to a new session.
      await devicePool.refreshDevices();
      expect(devicePool.getIdleDevices().map((idle) => idle.id)).not.toContain(device.deviceId);

      devicePool.noteLatePlatformShutdownSettled(captured);
      await devicePool.refreshDevices();
      expect(devicePool.getIdleDevices().map((idle) => idle.id)).toContain(device.deviceId);
      expect(await devicePool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
      expect(() => devicePool.assertSessionReadyForAutomation("next")).not.toThrow();
    });

    test("captures the exact session identity after its idle deadline", async () => {
      await bindOwnerSession("owner-session", "emulator-5554");
      const session = sessionManager.getSession("owner-session");
      if (!session) {
        throw new Error("expected owner session");
      }
      fakeTimer.advanceTime(31 * 60 * 1_000);

      const reservation = await devicePool.reserveDeviceForShutdown("emulator-5554");
      try {
        expect(reservation?.session).toBe(session);
      } finally {
        await reservation?.release();
      }
    });

    test("rejects cancelled binding and readiness reservation after the assignment mutex opens", async () => {
      const persistence = new DeferredDeviceSessionPersistence();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool();
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      const owner = devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      await persistence.waitForUpsert();
      const controller = new AbortController();
      const lateBinding = runWithAbortSignal(controller.signal, () =>
        devicePool.bindOrReuseDeviceSession(
          "expired-session",
          device.deviceId,
          "android",
          sourceImage,
        ),
      ).catch((error: unknown) => error);
      const lateReservation = runWithAbortSignal(controller.signal, () =>
        devicePool.reserveDeviceForReadiness(device.deviceId, device),
      ).catch((error: unknown) => error);
      controller.abort(new Error("provision deadline exhausted"));
      persistence.finishUpsert();
      await owner;
      expect(await lateBinding).toBe(controller.signal.reason);
      expect(await lateReservation).toBe(controller.signal.reason);
      expect(devicePool.getDevice(device.deviceId)?.sessionId).toBe("owner-session");
      expect(sessionManager.getSession("expired-session")).toBeNull();
    });

    test("captures session identity after an in-flight assignment publishes", async () => {
      const persistence = new DeferredDeviceSessionPersistence();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool();
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);

      const binding = devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      await persistence.waitForUpsert();
      const reservationPromise = devicePool.reserveDeviceForShutdown(device.deviceId);
      persistence.finishUpsert();
      await binding;
      const reservation = await reservationPromise;
      try {
        expect(reservation?.session).toBe(sessionManager.getSession("owner-session"));
      } finally {
        await reservation?.release();
      }
    });

    test("releases session identity when shutdown reservation aborts behind assignment", async () => {
      const persistence = new DeferredDeviceSessionPersistence();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = makePool();
      const owner = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const blocker = createBootedDevice("emulator-5556", "android", "Pixel 8");
      fakeDeviceManager.bootedDevices = [owner, blocker];
      await devicePool.initializeWithDevices([owner, blocker]);

      const ownerBinding = devicePool.bindOrReuseDeviceSession(
        "owner-session",
        owner.deviceId,
        "android",
        sourceImage,
      );
      await persistence.waitForUpsert();
      persistence.finishUpsert();
      await ownerBinding;

      persistence.deferNextUpsert();
      const blockingAssignment = devicePool.bindOrReuseDeviceSession(
        "blocking-session",
        blocker.deviceId,
        "android",
        sourceImage,
      );
      await persistence.waitForUpsert();

      const controller = new AbortController();
      const abortedReservation = devicePool
        .reserveDeviceForShutdown(owner.deviceId, controller.signal)
        .then(
          (reservation) => ({ reservation }),
          (error: unknown) => ({ error }),
        );
      controller.abort(new Error("shutdown reservation cancelled"));
      const retryReservation = devicePool.reserveDeviceForShutdown(owner.deviceId).then(
        (reservation) => ({ reservation }),
        (error: unknown) => ({ error }),
      );

      persistence.finishUpsert();
      await blockingAssignment;
      const abortedOutcome = await abortedReservation;
      expect(abortedOutcome.error).toBeInstanceOf(Error);
      expect((abortedOutcome.error as Error).message).toContain("cancelled");

      const retryOutcome = await retryReservation;
      expect(retryOutcome.error).toBeUndefined();
      expect(retryOutcome.reservation?.session).toBe(sessionManager.getSession("owner-session"));
      await retryOutcome.reservation?.release();
    });

    test("rejects a bound session while its device carries an intentional-shutdown marker", async () => {
      await bindOwnerSession("owner-session", "emulator-5554");

      devicePool.markIntentionalShutdown("emulator-5554");
      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).toThrow(
        /shutting down/,
      );

      devicePool.clearIntentionalShutdown("emulator-5554");
      expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).not.toThrow();
    });

    test("does not block a session bound to a different, healthy device", async () => {
      const owner = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const other = createBootedDevice("emulator-5556", "android", "Pixel 8");
      fakeDeviceManager.bootedDevices = [owner, other];
      await devicePool.initializeWithDevices([owner, other]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        owner.deviceId,
        "android",
        sourceImage,
      );
      await devicePool.bindOrReuseDeviceSession(
        "other-session",
        other.deviceId,
        "android",
        sourceImage,
      );

      const reservation = await devicePool.reserveDeviceForShutdown(owner.deviceId);
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }
      try {
        expect(() => devicePool.assertSessionReadyForAutomation("owner-session")).toThrow(
          /shutting down/,
        );
        // The sibling session on a healthy device is unaffected.
        expect(() => devicePool.assertSessionReadyForAutomation("other-session")).not.toThrow();
      } finally {
        await reservation.release();
      }
    });

    test("does not block an unknown session with no device binding", () => {
      expect(() => devicePool.assertSessionReadyForAutomation("no-such-session")).not.toThrow();
    });
  });

  describe("initializeWithDevices", () => {
    test("should initialize with empty device list", async () => {
      await devicePool.initializeWithDevices([]);
      expect(devicePool.getTotalDeviceCount()).toBe(0);
      expect(devicePool.getAvailableDeviceCount()).toBe(0);
    });

    test("should initialize with single device", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      expect(devicePool.getTotalDeviceCount()).toBe(1);
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      const device = devicePool.getDevice("emulator-5554");
      expect(device).not.toBeNull();
      expect(device?.status).toBe("idle");
      expect(device?.sessionId).toBeNull();
      expect(device?.assignmentCount).toBe(0);
      expect(device?.errorCount).toBe(0);
    });

    test("notifies the removal listener so a device session epoch is retired", async () => {
      const registry = new DeviceSessionRegistry(fakeTimer, new FakeIdGenerator(["uuid-a"]));
      const removedDeviceIds: string[] = [];
      let listenerObservedDeletedDevice = false;
      devicePool = makePool({
        onDeviceRemoved: (deviceId) => {
          listenerObservedDeletedDevice = devicePool.getDevice(deviceId) === null;
          removedDeviceIds.push(deviceId);
          registry.onDeviceDisconnected(deviceId);
        },
      });
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      const pooled = devicePool.getDevice("emulator-5554");
      if (!pooled) {
        throw new Error("expected pooled device");
      }
      const record = registry.onDeviceConnected({
        deviceId: pooled.id,
        platform: pooled.platform,
        incarnation: pooled.incarnation,
      });

      const removal = devicePool.removeDevice(pooled.id);

      expect(removedDeviceIds).toEqual([pooled.id]);
      expect(listenerObservedDeletedDevice).toBe(true);
      await removal;
      expect(registry.list()).toEqual([]);
      expect(registry.getByUuid(record.deviceSessionUuid)).toBeUndefined();
    });

    test("should initialize with multiple devices", async () => {
      const deviceIds = ["emulator-5554", "emulator-5556", "emulator-5558"];
      await devicePool.initializeWithDevices(deviceIds.map(createBootedDevice));
      expect(devicePool.getTotalDeviceCount()).toBe(3);
      expect(devicePool.getAvailableDeviceCount()).toBe(3);
      for (const deviceId of deviceIds) {
        const device = devicePool.getDevice(deviceId);
        expect(device).not.toBeNull();
        expect(device?.status).toBe("idle");
        expect(device?.sessionId).toBeNull();
      }
    });

    test("does not remove a same-serial device added after an absent disconnect capture", async () => {
      const device = createBootedDevice("emulator-5554");

      const disconnect = devicePool.removeDisconnectedDevice(device.deviceId);
      await devicePool.initializeWithDevices([device]);
      const replacement = devicePool.getDevice(device.deviceId);
      await disconnect;

      expect(devicePool.getDevice(device.deviceId)).toBe(replacement);
    });

    test("does not release a same-UUID replacement assignment after session persistence", async () => {
      const device = createBootedDevice("emulator-5554");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession("session-1", device.deviceId, device.platform);
      const originalAssignmentCount = devicePool.getDevice(device.deviceId)?.assignmentCount;

      await sessionManager.releaseSession("session-1", "allocation-rollback");
      await devicePool.bindOrReuseDeviceSession("session-1", device.deviceId, device.platform);
      const replacement = devicePool.getDevice(device.deviceId);
      expect(replacement?.assignmentCount).toBe((originalAssignmentCount ?? 0) + 1);

      await devicePool.releaseDevice(device.deviceId, "session-1");

      expect(devicePool.getDevice(device.deviceId)).toBe(replacement);
      expect(replacement).toMatchObject({
        sessionId: "session-1",
        status: "busy",
      });
    });

    // Boundary row (PARAM-7): the pool is keyed by device id, so two devices
    // with the same id collapse to a single tracked entry rather than being
    // double-counted. Pins the de-dup invariant a duplicate-id feed depends on.
    test("collapses duplicate device ids to a single tracked device", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5554"),
      ]);
      expect(devicePool.getTotalDeviceCount()).toBe(1);
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
    });

    test("records the source AVD when a recovery boot races with pool refresh", async () => {
      const ready = createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)");
      const source: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      await devicePool.initializeWithDevices([ready]);

      await devicePool.addDevice(ready, source);

      expect(devicePool.getDevice("emulator-5554")?.avdName).toBe("Pixel 8");
    });

    test("replaces stale AVD identity at a same-serial authoritative boot boundary", async () => {
      const ready = createBootedDevice("emulator-5554", "android", "Pixel");
      await devicePool.addDevice(ready, {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      });

      await devicePool.addDevice(ready, {
        name: "Pixel 9",
        platform: "android",
        isRunning: false,
        source: "local",
      });

      expect(devicePool.getDevice(ready.deviceId)?.avdName).toBe("Pixel 9");
    });

    test("an authoritative same-serial replacement clears an old intentional-stop marker", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const ready = createBootedDevice("emulator-5554", "android", "Pixel");
      try {
        devicePool = makePool({ recoveryPolicy: { onLoss: true, maxAttempts: 2 } });
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        devicePool.markIntentionalShutdown(ready.deviceId);
        await devicePool.addDevice(ready, {
          name: "Pixel 9",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        fakeDeviceManager.bootedDevices = [];

        await devicePool.removeDisconnectedDevice(ready.deviceId, false);

        expect(fakeDeviceManager.startedDevices.map((device) => device.name)).toEqual(["Pixel 9"]);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("intentional shutdown remains a current disconnect for monitor cleanup", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      const device = devicePool.getDevice("emulator-5554");
      if (!device) {
        throw new Error("expected pooled device");
      }
      devicePool.markIntentionalShutdown(device.id);

      expect(await devicePool.isCurrentDisconnectedDevice(device)).toBe("current");
    });

    test("does not accept a different AVD that reuses the disconnected emulator serial", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      try {
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        const disconnected = devicePool.getDevice(ready.deviceId);
        if (!disconnected) {
          throw new Error("expected disconnected pooled device");
        }
        fakeDeviceManager.bootedDevices = [
          createBootedDevice("emulator-5554", "android", "Pixel 9"),
        ];

        expect(await devicePool.isCurrentDisconnectedDevice(disconnected)).toBe("current");
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("retains a same-serial Android emulator when its AVD name is unresolved", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      try {
        devicePool = makePool({ recoveryPolicy: { onLoss: true, maxAttempts: 2 } });
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        const disconnected = devicePool.getDevice(ready.deviceId);
        if (!disconnected) {
          throw new Error("expected disconnected pooled device");
        }
        fakeDeviceManager.bootedDevices = [
          createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)"),
        ];

        expect(await devicePool.isCurrentDisconnectedDevice(disconnected)).toBe("recovered");
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("reports an unknown disconnect state when Android rediscovery discovery fails", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      try {
        devicePool = makePool({ recoveryPolicy: { onLoss: true, maxAttempts: 2 } });
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        const disconnected = devicePool.getDevice(ready.deviceId);
        if (!disconnected) {
          throw new Error("expected disconnected pooled device");
        }
        fakeDeviceManager.failedPlatforms = new Set(["android"]);

        expect(await devicePool.isCurrentDisconnectedDevice(disconnected)).toBe("unknown");
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("stale disconnect validation rejects a same-serial replacement added during discovery", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredDiscoveryFakeDeviceManager();
      devicePool = makePool({ deviceManager: manager });
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const source: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      try {
        await devicePool.addDevice(ready, source);
        const original = devicePool.getDevice(ready.deviceId);
        if (!original) {
          throw new Error("expected original pooled device");
        }
        const validation = devicePool.isCurrentDisconnectedDevice(original);
        await manager.waitForDiscoveryStart();
        await devicePool.removeDevice(ready.deviceId);
        await devicePool.addDevice(ready, source);
        const replacement = devicePool.getDevice(ready.deviceId);

        manager.releaseDiscovery();

        expect(await validation).toBe("recovered");
        expect(devicePool.getDevice(ready.deviceId)).toBe(replacement);
      } finally {
        manager.releaseDiscovery();
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("stale disconnect cleanup preserves a same-serial replacement added during discovery", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredDiscoveryFakeDeviceManager();
      devicePool = makePool({ deviceManager: manager });
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const source: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      try {
        await devicePool.addDevice(ready, source);
        const cleanup = devicePool.removeDisconnectedDevice(ready.deviceId);
        await manager.waitForDiscoveryStart();
        await devicePool.removeDevice(ready.deviceId);
        await devicePool.addDevice(ready, source);
        const replacement = devicePool.getDevice(ready.deviceId);

        manager.releaseDiscovery();
        await cleanup;

        expect(devicePool.getDevice(ready.deviceId)).toBe(replacement);
      } finally {
        manager.releaseDiscovery();
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("retains a recovery-owned emulator when detailed discovery throws", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new ThrowingDiscoveryFakeDeviceManager();
      devicePool = makePool({ deviceManager: manager });
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      try {
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });

        await devicePool.removeDisconnectedDevice(ready.deviceId);

        expect(devicePool.getDevice(ready.deviceId)).not.toBeNull();
        expect(manager.startedDevices).toHaveLength(0);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });
  });
});
