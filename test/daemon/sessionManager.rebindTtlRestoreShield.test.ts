import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SESSION_RELEASE_TEARDOWN_CAP_MS, SessionManager } from "../../src/daemon/sessionManager";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const oldDevice = "emulator-5554";
const managers: SessionManager[] = [];
const flush = async () => {
  for (let index = 0; index < 100; index++) {
    await Promise.resolve();
  }
};

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
});

class SignalAwareNetwork {
  readonly calls: Array<{ deviceId: string; profile: string; signal: AbortSignal | undefined }> =
    [];
  readonly reached: string[] = [];
  hang = false;

  async restore(deviceId: string, profile: string): Promise<void> {
    const signal = getAbortSignal();
    this.calls.push({ deviceId, profile, signal });
    if (signal?.aborted) {
      throw signal.reason;
    }
    if (this.hang) {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    this.reached.push(deviceId);
  }
}

async function harness() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const fake = new SignalAwareNetwork();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({ restore: async () => {} }),
    () => ({ restore: async () => {} }),
    (device) => ({ restore: (profile) => fake.restore(device.deviceId, profile) }),
  );
  managers.push(manager);
  const session = await manager.createSession("owner", oldDevice, "android");
  manager.setNetworkCondition("owner", { initialProfile: "none" });
  return { timer, fake, manager, session };
}

describe("rebind and network TTL restores use the teardown shield", () => {
  for (const path of ["rebind", "ttl"] as const) {
    test.each([true, false])(
      `${path} restores under an ambient signal (cancelled=%s)`,
      async (cancelled) => {
        const h = await harness();
        const caller = new AbortController();
        if (cancelled) {
          caller.abort(new DOMException("Cancelled", "AbortError"));
        }
        await runWithAbortSignal(caller.signal, async () => {
          if (path === "rebind") {
            await h.manager.rebindSession("owner", "emulator-5556", "android");
            expect(h.manager.getDeviceForSession("owner")).toBe("emulator-5556");
          } else {
            h.manager.scheduleNetworkConditionExpiry(h.session, 1);
            h.timer.advanceTime(1000);
            await flush();
          }
          expect(getAbortSignal()).toBe(caller.signal);
        });
        expect(h.fake.reached).toEqual([oldDevice]);
        expect(h.fake.calls).toHaveLength(1);
        expect(h.fake.calls[0]?.profile).toBe("none");
        expect(h.fake.calls[0]?.signal).toBeDefined();
        expect(h.fake.calls[0]?.signal?.aborted).toBe(false);
        expect(h.fake.calls[0]?.signal).not.toBe(caller.signal);
        expect(h.manager.getNetworkCondition("owner")).toBeUndefined();
        await flush();
        expect(h.manager.getPendingDeviceCleanup(oldDevice)).toBeNull();
        expect(h.timer.getPendingTimeouts()).not.toContain(SESSION_RELEASE_TEARDOWN_CAP_MS);
      },
    );

    test(`${path} aborts a hung restore and settles cleanup at the shield cap`, async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const h = await harness();
        h.fake.hang = true;
        const caller = new AbortController();
        let rebinding: Promise<unknown> | undefined;
        await runWithAbortSignal(caller.signal, async () => {
          if (path === "rebind") {
            rebinding = h.manager.rebindSession("owner", "emulator-5556", "android");
            await flush();
          } else {
            h.manager.scheduleNetworkConditionExpiry(h.session, 1);
            h.timer.advanceTime(1000);
            await flush();
          }
        });
        const shield = h.fake.calls[0]?.signal;
        expect(shield).toBeDefined();
        expect(shield).not.toBe(caller.signal);
        await h.timer.advanceTimeAsync(1000);
        await rebinding;
        expect(h.manager.getPendingDeviceCleanup(oldDevice)).not.toBeNull();
        await h.timer.advanceTimeAsync(SESSION_RELEASE_TEARDOWN_CAP_MS - 1001);
        expect(shield?.aborted).toBe(false);
        expect(h.manager.getPendingDeviceCleanup(oldDevice)).not.toBeNull();
        await h.timer.advanceTimeAsync(2);
        await flush();
        expect(shield?.aborted).toBe(true);
        expect(caller.signal.aborted).toBe(false);
        expect(h.fake.reached).toEqual([]);
        expect(h.manager.getPendingDeviceCleanup(oldDevice)).toBeNull();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("network-condition restore finished"),
        );
        h.fake.hang = false;
        await h.timer.advanceTimeAsync(1000);
        await flush();
      } finally {
        warn.mockRestore();
      }
    });
  }

  test.each(["rebind", "release"] as const)("%s cancels the old device TTL", async (path) => {
    const h = await harness();
    h.manager.scheduleNetworkConditionExpiry(h.session, 1);
    if (path === "rebind") {
      await h.manager.rebindSession("owner", "emulator-5556", "android");
    } else {
      await h.manager.releaseSession("owner");
    }
    await h.timer.advanceTimeAsync(2000);
    expect(h.fake.reached).toEqual([oldDevice]);
    expect(h.fake.calls).toHaveLength(1);
    expect(h.manager.getPendingDeviceCleanup(oldDevice)).toBeNull();
  });
});
