import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DeviceConditionRegistry } from "../../../src/features/deviceCondition/DeviceConditionRegistry";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "../../../src/features/deviceCondition/DeviceConditionController";
import type {
  DeviceConditionInput,
  DeviceConditionKey,
} from "../../../src/features/deviceCondition/DeviceConditionTypes";

class FakeInjector implements DeviceConditionInjector {
  resetCount = 0;
  clean = true;
  constructor(readonly key: DeviceConditionKey) {}
  apply(): Promise<DeviceConditionApplyOutcome> {
    this.clean = false;
    return Promise.resolve({
      status: "applied",
      reset: () => {
        this.resetCount += 1;
        this.clean = true;
        return Promise.resolve();
      },
    });
  }
  isClean(): Promise<boolean> {
    return Promise.resolve(this.clean);
  }
}

function makeRegistry() {
  const timer = new FakeTimer();
  const injector = new FakeInjector("faults.battery");
  const registry = new DeviceConditionRegistry(
    (_owner, key) => (key === "faults.battery" ? injector : undefined),
    timer,
  );
  return { registry, timer, injector };
}

const owner = { deviceId: "emulator-5554", sessionUuid: "session-1" };
const applyA: DeviceConditionInput = { faults: { battery: "unplug" } };

/** Flush the microtasks a timer-fired async restore chains through. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe("DeviceConditionRegistry (#14050)", () => {
  test("a session lease restores every condition when it expires", async () => {
    const { registry, timer, injector } = makeRegistry();
    const result = await registry.apply(owner, { ...applyA, expiresInSeconds: 10 });
    expect(result.leaseExpiresAt).toBe(timer.now() + 10_000);
    expect(registry.hasActiveConditions(owner)).toBe(true);

    timer.advanceTime(10_000);
    await flush();
    expect(injector.resetCount).toBe(1);
    expect(registry.hasActiveConditions(owner)).toBe(false);
  });

  test("a renewing apply cancels the prior lease timer", async () => {
    const { registry, timer, injector } = makeRegistry();
    await registry.apply(owner, { ...applyA, expiresInSeconds: 10 });
    // Renew before the first lease fires: reset the prior application and re-apply under a fresh lease.
    timer.advanceTime(5_000);
    await registry.apply(owner, { reset: true, ...applyA, expiresInSeconds: 10 });
    expect(injector.resetCount).toBe(1); // the reset:true cleared the first application
    // The original 10s deadline (now 5s away) must not fire.
    timer.advanceTime(5_000);
    await flush();
    expect(injector.resetCount).toBe(1);
    // The renewed 10s deadline fires 10s after the renewal, tearing down the re-application.
    timer.advanceTime(5_000);
    await flush();
    expect(injector.resetCount).toBe(2);
  });

  test("a TTL is refused the degrade in direct mode by never arming (no sessionUuid)", async () => {
    const { registry, timer, injector } = makeRegistry();
    const sessionless = { deviceId: "emulator-5554" };
    const result = await registry.apply(sessionless, { ...applyA, expiresInSeconds: 10 });
    expect(result.leaseExpiresAt).toBeUndefined();
    timer.advanceTime(10_000);
    await flush();
    // Without a session the lease never arms; conditions persist until explicit restore.
    expect(injector.resetCount).toBe(0);
    expect(registry.hasActiveConditions(sessionless)).toBe(true);
  });

  test("explicit restore tears down and drops the slot", async () => {
    const { registry, injector } = makeRegistry();
    await registry.apply(owner, applyA);
    expect(await registry.restore(owner)).toBe(true);
    expect(injector.resetCount).toBe(1);
    expect(registry.hasActiveConditions(owner)).toBe(false);
  });

  test("restoreSession restores every device a session touched", async () => {
    const timer = new FakeTimer();
    const a = new FakeInjector("faults.battery");
    const b = new FakeInjector("faults.battery");
    const injectors: Record<string, FakeInjector> = { "emulator-5554": a, "emulator-5556": b };
    const registry = new DeviceConditionRegistry(
      (o, key) => (key === "faults.battery" ? injectors[o.deviceId] : undefined),
      timer,
    );
    await registry.apply({ deviceId: "emulator-5554", sessionUuid: "s" }, applyA);
    await registry.apply({ deviceId: "emulator-5556", sessionUuid: "s" }, applyA);
    const outcomes = await registry.restoreSession("s");
    expect(outcomes).toEqual([true, true]);
    expect(a.resetCount).toBe(1);
    expect(b.resetCount).toBe(1);
  });

  test("a restore that leaves a condition dirty warns with its key and reason (#14069)", async () => {
    const { registry, injector } = makeRegistry();
    await registry.apply(owner, applyA);
    // The reset runs but the device still reads dirty: the failure has no thrown error to log.
    injector.isClean = () => Promise.resolve(false);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await registry.restore(owner)).toBe(false);
      expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
        "[deviceCondition] explicit restore for emulator-5554 left 1 condition(s) unrestored: faults.battery (reset ran but the device did not read clean)",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("restoring an owner with nothing applied is a no-op success", async () => {
    const { registry } = makeRegistry();
    expect(await registry.restore({ deviceId: "never-touched" })).toBe(true);
  });
});
