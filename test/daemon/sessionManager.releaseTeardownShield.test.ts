import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SESSION_RELEASE_TEARDOWN_CAP_MS, SessionManager } from "../../src/daemon/sessionManager";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  getAbortSignal,
  isClientCancelled,
  runWithAbortSignal,
} from "../../src/utils/AbortContext";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const device = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
const flush = async () => {
  for (let index = 0; index < 100; index++) {
    await Promise.resolve();
  }
};

const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
  PlatformDeviceManagerFactory.reset();
});

type RestoreKind = "keep-awake" | "biometric" | "network";

/**
 * Restorers that behave like the real clients: AdbClient and SimCtlClient resolve
 * `signal ?? getAbortSignal()` and refuse to dispatch once it is aborted.
 */
class SignalAwareDevice {
  /** Restores that reached the device. */
  readonly reached: RestoreKind[] = [];
  /** The next N restores of each kind fail as device-side errors, whatever the signal. */
  readonly failFirst: Partial<Record<RestoreKind, number>> = {};
  /** Gate every restore on this promise, to hold a drain open. */
  gate: Promise<void> | undefined;
  /** When set, a restore of this kind never completes on its own, only when its signal aborts. */
  hang: RestoreKind | undefined;
  /** When true, every restore fails as a device-side error under a live signal. */
  deviceFails = false;

  restorer(kind: RestoreKind): () => Promise<void> {
    return async () => {
      const signal = getAbortSignal();
      if (signal?.aborted) {
        throw signal.reason ?? new Error("aborted before dispatch");
      }
      if (this.hang === kind) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
            once: true,
          });
        });
        return;
      }
      await this.gate;
      const failuresLeft = this.failFirst[kind] ?? 0;
      if (this.deviceFails || failuresLeft > 0) {
        this.failFirst[kind] = Math.max(0, failuresLeft - 1);
        throw new Error(`${kind} command failed on the device`);
      }
      this.reached.push(kind);
    };
  }
}

async function harness() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const markers = new FakeDeviceHealthMarkers(timer);
  const fake = new SignalAwareDevice();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({ restore: fake.restorer("keep-awake") }),
    () => ({ restore: fake.restorer("biometric") }),
    () => ({ restore: fake.restorer("network") }),
  );
  managers.push(manager);
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [device]);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "teardown-shield", {
      timer,
      deviceManager: utils,
      deviceHealthMarkers: markers,
    }),
  );
  await pool.initializeWithDevices([device]);
  return { timer, manager, pool, fake };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function ownDevice(h: Harness, kinds: readonly RestoreKind[]): Promise<void> {
  await h.pool.bindOrReuseDeviceSession("old", device.deviceId, "android");
  if (kinds.includes("keep-awake")) {
    h.manager.setKeepScreenAwake("old", { applied: true });
  }
  if (kinds.includes("biometric")) {
    h.manager.setBiometricEnrollment("old", { initialEnrollment: "not_enrolled" });
  }
  if (kinds.includes("network")) {
    h.manager.setNetworkCondition("old", { initialProfile: "none" });
  }
}

/** The tool wrapper's `finally`: the plan's request is already cancelled when it releases. */
async function releaseAfterCancel(h: Harness): Promise<{
  released: string | null;
  signal: AbortSignal;
  ambientAfter: AbortSignal | undefined;
}> {
  const cancelled = new AbortController();
  cancelled.abort(new DOMException("The operation was aborted.", "AbortError"));
  let ambientAfter: AbortSignal | undefined;
  const released = await runWithAbortSignal(cancelled.signal, async () => {
    const result = await h.manager.releaseSession("old", "plan-auto-release");
    ambientAfter = getAbortSignal();
    return result;
  });
  return { released, signal: cancelled.signal, ambientAfter };
}

describe("session release teardown is shielded from the caller's signal (#10198)", () => {
  test.each(["keep-awake", "biometric", "network"] as const)(
    "a cancelled plan's release still restores %s on the device and leaves it healthy and assignable",
    async (kind) => {
      const h = await harness();
      await ownDevice(h, [kind]);

      const { released } = await releaseAfterCancel(h);
      await h.pool.releaseDevice(device.deviceId, "old");
      await flush();

      expect(released).toBe(device.deviceId);
      expect(h.fake.reached).toEqual([kind]);
      expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
      expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
      expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
    },
  );

  test("every restorer of one release reaches the device, and the retries run under the shield too", async () => {
    const h = await harness();
    await ownDevice(h, ["keep-awake", "biometric", "network"]);
    // The first biometric and network attempts fail; their 250 ms retries must succeed.
    h.fake.failFirst.biometric = 1;
    h.fake.failFirst.network = 1;

    await releaseAfterCancel(h);
    const cleanup = h.manager.getPendingDeviceCleanup(device.deviceId);
    expect(cleanup).not.toBeNull();
    await h.timer.advanceTimeAsync(250);
    await cleanup;

    expect([...h.fake.reached].sort()).toEqual(["biometric", "keep-awake", "network"]);
    expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
  });

  test("the cancelled caller still observes its own cancellation", async () => {
    const h = await harness();
    await ownDevice(h, ["network"]);

    const { signal, ambientAfter } = await releaseAfterCancel(h);

    expect(signal.aborted).toBe(true);
    expect(ambientAfter).toBe(signal);
    expect(isClientCancelled(ambientAfter)).toBe(true);
  });

  test("a restore that genuinely fails under a live signal still quarantines the device", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      h.fake.deviceFails = true;
      await ownDevice(h, ["network"]);

      await releaseAfterCancel(h);
      await h.pool.releaseDevice(device.deviceId, "old");
      for (const delay of [250, 250]) {
        await h.timer.advanceTimeAsync(delay);
        await flush();
      }

      expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("network-condition");
      await expect(h.pool.assignDeviceToSession("next", "android")).rejects.toThrow(
        "network-condition",
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("a device marked by a failed restore is recovered under its own signal after a cancelled release", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      h.fake.deviceFails = true;
      await ownDevice(h, ["network"]);
      await releaseAfterCancel(h);
      await h.pool.releaseDevice(device.deviceId, "old");
      for (const delay of [250, 250]) {
        await h.timer.advanceTimeAsync(delay);
        await flush();
      }
      expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeDefined();

      h.fake.deviceFails = false;
      await h.timer.advanceTimeAsync(1000);
      await flush();

      expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
      expect(h.fake.reached).toEqual(["network"]);
      expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
    } finally {
      warn.mockRestore();
    }
  });

  describe("the teardown cap", () => {
    test("a restore that outlives the cap is aborted, recorded as abandoned, and the device is released", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const h = await harness();
        h.fake.hang = "network";
        await ownDevice(h, ["network"]);

        const release = releaseAfterCancel(h);
        await flush();
        // The first attempt's own 1 s budget elapses: the release returns, quarantine holds.
        await h.timer.advanceTimeAsync(1000);
        await release;
        await h.pool.releaseDevice(device.deviceId, "old");
        expect(h.manager.getPendingDeviceCleanup(device.deviceId)).not.toBeNull();

        await h.timer.advanceTimeAsync(SESSION_RELEASE_TEARDOWN_CAP_MS - 1000);
        await flush();

        expect(h.manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
        expect(h.pool.getDeviceHealthMarker(device.deviceId)?.reason).toBe("network-condition");
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`network-condition restore finished on ${device.deviceId}`),
        );

        // The abandoned restore is retried by the bounded recovery, under a fresh signal.
        h.fake.hang = undefined;
        await h.timer.advanceTimeAsync(1000);
        await flush();
        expect(h.fake.reached).toEqual(["network"]);
        expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
        expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
      } finally {
        warn.mockRestore();
      }
    });

    test("a release that finishes inside the cap leaves no timer or abandoned record behind", async () => {
      const h = await harness();
      await ownDevice(h, ["network", "biometric"]);

      await releaseAfterCancel(h);
      await flush();

      expect(h.timer.getPendingTimeouts()).not.toContain(SESSION_RELEASE_TEARDOWN_CAP_MS);
      expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    });
  });

  test("the device stays unassignable while the drain runs, then becomes assignable", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    h.fake.gate = gate.promise;
    await ownDevice(h, ["network"]);

    const release = releaseAfterCancel(h);
    await flush();
    await h.timer.advanceTimeAsync(1000);
    await release;
    await h.pool.releaseDevice(device.deviceId, "old");
    const cleanup = h.manager.getPendingDeviceCleanup(device.deviceId);
    expect(cleanup).not.toBeNull();
    expect(h.pool.getDevice(device.deviceId)?.status).toBe("busy");
    expect(h.pool.getStats().idle).toBe(0);
    await expect(
      h.pool.bindOrReuseDeviceSession(
        "next",
        device.deviceId,
        "android",
        undefined,
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow("cleanup");

    gate.resolve();
    await cleanup;
    await flush();

    expect(h.fake.reached).toEqual(["network"]);
    expect(h.pool.getDeviceHealthMarker(device.deviceId)).toBeUndefined();
    expect(await h.pool.assignDeviceToSession("next", "android")).toBe(device.deviceId);
  });
});
