import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { logger } from "../../src/utils/logger";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

// Regression for #3593: the emulator-exit eviction was a fire-and-forget
// `void this.evictStartedDeviceAfterProcessExit(...)` with no rejection handler.
// If the eviction chain rejected, it surfaced as an unhandled promise rejection
// fired from a ChildProcess "exit" listener. It must now be caught and logged.
describe("DevicePool emulator-exit eviction rejection handling", () => {
  let pool: DevicePool;
  let sessionManager: SessionManager;
  let timer: FakeTimer;
  let fakeDeviceUtils: FakeDeviceUtils;
  const androidDevice = {
    name: "Pixel 7",
    platform: "android" as const,
    deviceId: "emulator-5554",
  };

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    fakeDeviceUtils = new FakeDeviceUtils();
    pool = new DevicePool(sessionManager, "daemon-session-1", timer, undefined, fakeDeviceUtils);
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await pool.initializeWithDevices([androidDevice]);
  });

  afterEach(() => {
    timer.clearAllTimers?.();
  });

  it("logs a warning and does not throw when eviction rejects on process exit", async () => {
    const warnSpy = spyOn(logger, "warn");
    const evictError = new Error("removeDevice failed");
    // Force the eviction chain to reject.
    const evictSpy = spyOn(
      pool as unknown as {
        evictMissingPooledDevice: (...args: unknown[]) => Promise<void>;
      },
      "evictMissingPooledDevice",
    ).mockRejectedValue(evictError);

    const child = new EventEmitter();
    // Register the exit listener under test.
    (
      pool as unknown as {
        trackStartedDeviceProcess: (device: unknown, child: unknown) => void;
      }
    ).trackStartedDeviceProcess(androidDevice, child);

    // Fire the process-exit event; the rejection must be caught, not unhandled.
    child.emit("exit", 1, null);

    // Let the rejected eviction promise settle through the .catch (microtasks only).
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(evictSpy).toHaveBeenCalledTimes(1);
    const loggedEviction = warnSpy.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("Failed to evict emulator-5554"),
    );
    expect(loggedEviction).toBe(true);

    warnSpy.mockRestore();
    evictSpy.mockRestore();
  });

  it("persists redacted post-ready process diagnostics and recovery outcome", async () => {
    const incidentStore = new InMemoryEmulatorLossIncidentStore(
      timer,
      new CountingIdGenerator("test"),
    );
    const diagnosticPool = new DevicePool(
      sessionManager,
      "daemon-session-1",
      timer,
      undefined,
      fakeDeviceUtils,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { onLoss: false, maxAttempts: 2 },
      undefined,
      incidentStore,
    );
    await diagnosticPool.initializeWithDevices([androidDevice]);
    const pooled = diagnosticPool.getDevice(androidDevice.deviceId)!;
    pooled.avdName = "Pixel_7";
    pooled.androidImage = {
      name: "Pixel_7",
      platform: "android",
      isRunning: false,
      source: "local",
    };

    const child = new EventEmitter() as unknown as {
      once(
        event: "exit",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
      ): void;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    await (
      diagnosticPool as unknown as {
        trackStartedDeviceProcess: (device: unknown, child: unknown) => Promise<void>;
      }
    ).trackStartedDeviceProcess(androidDevice, child);
    child.stdout.emit("data", Buffer.from("token="));
    (child as unknown as EventEmitter).emit("exit", 1, null);
    child.stderr.emit("data", Buffer.from("emulator died\n"));
    child.stdout.emit("data", Buffer.from("should-not-leak\n"));
    (child as unknown as EventEmitter).emit("close", 1, null);

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    const [incident] = await incidentStore.list();
    expect(incident).toMatchObject({
      deviceId: "emulator-5554",
      avdName: "Pixel_7",
      detectionPath: "watched-process-exit",
      processExit: { code: 1, signal: null },
      outputTail: "token=[REDACTED]\nemulator died\n",
      recovery: {
        policy: { onLoss: false, maxAttempts: 2 },
        attempts: [],
        outcome: "not-attempted",
      },
    });
    expect(incident.outputTail).not.toContain("should-not-leak");
  });
});
