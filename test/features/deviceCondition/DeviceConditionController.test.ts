import { describe, expect, test } from "bun:test";
import {
  DeviceConditionController,
  type DeviceConditionInjector,
  type DeviceConditionApplyOutcome,
} from "../../../src/features/deviceCondition/DeviceConditionController";
import { FakeLogger } from "../../fakes/FakeLogger";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import type { DeviceConditionKey } from "../../../src/features/deviceCondition/DeviceConditionTypes";

/** A recording injector whose apply/reset/isClean behaviour the test drives. */
class FakeInjector implements DeviceConditionInjector {
  applied: string[] = [];
  resetCount = 0;
  clean = true;
  failReset = false;
  failApply = false;
  failApplyWithOwedReset = false;
  recover?: DeviceConditionInjector["recover"];
  constructor(readonly key: DeviceConditionKey) {}

  apply(value: string): Promise<DeviceConditionApplyOutcome> {
    if (this.failApplyWithOwedReset) {
      this.clean = false;
      return Promise.reject(
        new OwedResetError("half applied", () => {
          this.resetCount += 1;
          this.clean = true;
          return Promise.resolve();
        }),
      );
    }
    if (this.failApply) {
      return Promise.reject(new Error("injector refused"));
    }
    this.applied.push(value);
    this.clean = false;
    return Promise.resolve({
      status: "applied",
      reset: () => {
        this.resetCount += 1;
        if (this.failReset) {
          return Promise.reject(new Error("reset failed"));
        }
        this.clean = true;
        return Promise.resolve();
      },
    });
  }

  isClean(): Promise<boolean> {
    return Promise.resolve(this.clean);
  }
}

function controllerWith(injectors: Map<DeviceConditionKey, DeviceConditionInjector>) {
  return new DeviceConditionController((key) => injectors.get(key), new FakeLogger());
}

describe("DeviceConditionController (#14050)", () => {
  for (const initialRecovery of ["unset", "reset"] as const) {
    for (const cleanup of ["unset", "reset"] as const) {
      test(`a successful apply supersedes failed ${initialRecovery} recovery before ${cleanup}`, async () => {
        const injector = new FakeInjector("faults.memoryPressure");
        injector.recover = () => Promise.reject(new Error("device offline"));
        const controller = controllerWith(new Map([[injector.key, injector]]));
        const failed = await controller.apply(
          initialRecovery === "unset" ? { faults: { memoryPressure: "unset" } } : { reset: true },
        );
        expect(failed.success).toBe(false);
        expect(controller.hasActiveConditions()).toBe(true);
        injector.recover = () => Promise.resolve(null);
        const applied = await controller.apply({ faults: { memoryPressure: "on" } });
        expect(applied.success).toBe(true);
        const cleared = await controller.apply(
          cleanup === "unset" ? { faults: { memoryPressure: "unset" } } : { reset: true },
        );
        expect(injector.resetCount).toBe(1);
        expect(injector.clean).toBe(true);
        expect(cleared.success).toBe(true);
        if (cleanup === "unset") {
          expect(cleared.changes).toEqual([{ key: injector.key, status: "cleared" }]);
        } else {
          expect(cleared.restore).toEqual({
            restored: [injector.key],
            failures: [],
            verifiedClean: true,
          });
        }
        const reset = await controller.apply({ reset: true });
        expect(reset.success).toBe(true);
        expect(reset.restore?.verifiedClean).toBe(true);
        expect(controller.hasActiveConditions()).toBe(false);
      });
    }
  }

  test("an owed reset supersedes failed recovery even though apply is unsupported", async () => {
    const injector = new FakeInjector("faults.memoryPressure");
    injector.recover = () => Promise.reject(new Error("device offline"));
    const controller = controllerWith(new Map([[injector.key, injector]]));
    expect((await controller.apply({ reset: true })).success).toBe(false);
    injector.recover = () => Promise.resolve(null);
    injector.failApplyWithOwedReset = true;
    const applied = await controller.apply({ faults: { memoryPressure: "on" } });
    expect(applied.success).toBe(false);
    expect(controller.hasActiveConditions()).toBe(true);
    const cleared = await controller.apply({ faults: { memoryPressure: "unset" } });
    expect(cleared.success).toBe(true);
    expect(cleared.changes).toEqual([{ key: injector.key, status: "cleared" }]);
    expect(injector.resetCount).toBe(1);
    expect(injector.clean).toBe(true);
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("failed recovery keeps reset unsuccessful and the key active until a dirty device is recovered", async () => {
    const injector = new FakeInjector("faults.memoryPressure");
    injector.recover = () => Promise.reject(new Error("device offline"));
    const controller = controllerWith(new Map([[injector.key, injector]]));
    const result = await controller.apply({ reset: true });
    expect(result.success).toBe(false);
    expect(result.restore).toEqual({
      restored: [],
      failures: [
        {
          key: injector.key,
          error:
            "Could not check the device for an abandoned faults.memoryPressure fixture (device offline). Reconnect the device and run reset again, or release the session to retry.",
        },
      ],
      verifiedClean: false,
    });
    expect(controller.hasActiveConditions()).toBe(true);
    expect(controller.activeKeys()).toEqual([injector.key]);
    injector.clean = false;
    injector.recover = async () => (await injector.apply("on")).reset ?? null;
    const retried = await controller.apply({ reset: true });
    expect(injector.resetCount).toBe(1);
    expect(retried.success).toBe(true);
    expect(retried.restore).toEqual({
      restored: [injector.key],
      failures: [],
      verifiedClean: true,
    });
    expect(controller.hasActiveConditions()).toBe(false);
    expect(controller.activeKeys()).toEqual([]);
  });

  test("failed recovery makes unset unsupported and a clean recovery clears the obligation", async () => {
    const injector = new FakeInjector("faults.memoryPressure");
    injector.recover = () => Promise.reject(new Error("device offline"));
    const controller = controllerWith(new Map([[injector.key, injector]]));
    const result = await controller.apply({ faults: { memoryPressure: "unset" } });
    expect(result.success).toBe(false);
    expect(result.changes).toEqual([
      {
        key: injector.key,
        status: "unsupported",
        detail:
          "Could not check the device for an abandoned faults.memoryPressure fixture (device offline). Reconnect the device and run reset again, or release the session to retry.",
      },
    ]);
    expect(controller.hasActiveConditions()).toBe(true);
    injector.recover = () => Promise.resolve(null);
    const retried = await controller.apply({ reset: true });
    expect(retried.success).toBe(true);
    expect(retried.restore).toEqual({ restored: [], failures: [], verifiedClean: true });
    expect(injector.resetCount).toBe(0);
    expect(controller.hasActiveConditions()).toBe(false);
    expect(controller.activeKeys()).toEqual([]);
  });

  test("a condition with no injector is reported unsupported, not silently dropped", async () => {
    const controller = controllerWith(new Map());
    const result = await controller.apply({ faults: {}, rootState: "unset" });
    // rootState: unset with no prior application is 'unchanged'; a real value would be unsupported.
    const root = result.changes.find((change) => change.key === "rootState");
    expect(root?.status).toBe("unchanged");
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("reset undoes applied conditions newest-first and verifies clean", async () => {
    const first = new FakeInjector("faults.battery");
    const second = new FakeInjector("faults.lowPower");
    const controller = controllerWith(
      new Map<DeviceConditionKey, DeviceConditionInjector>([
        ["faults.battery", first],
        ["faults.lowPower", second],
      ]),
    );
    // Two separate applies so both register a reset.
    await controller.apply({ faults: { battery: "unplug" } });
    await controller.apply({ faults: { lowPower: "on" } });
    expect(controller.activeKeys()).toEqual(["faults.battery", "faults.lowPower"]);

    const report = await controller.restore();
    expect(report.restored).toEqual(["faults.lowPower", "faults.battery"]);
    expect(report.verifiedClean).toBe(true);
    expect(controller.hasActiveConditions()).toBe(false);
    expect(first.resetCount).toBe(1);
    expect(second.resetCount).toBe(1);
  });

  test("a failed reset keeps the condition active and is reported as a failure", async () => {
    const injector = new FakeInjector("faults.battery");
    injector.failReset = true;
    const controller = controllerWith(
      new Map<DeviceConditionKey, DeviceConditionInjector>([["faults.battery", injector]]),
    );
    await controller.apply({ faults: { battery: "unplug" } });
    const report = await controller.restore();
    expect(report.verifiedClean).toBe(false);
    expect(report.failures[0]?.key).toBe("faults.battery");
    expect(controller.hasActiveConditions()).toBe(true);
  });

  test("a reset that runs but does not read clean is a verified-clean failure", async () => {
    const injector = new FakeInjector("faults.battery");
    const controller = controllerWith(
      new Map<DeviceConditionKey, DeviceConditionInjector>([["faults.battery", injector]]),
    );
    await controller.apply({ faults: { battery: "unplug" } });
    // Reset runs but the device still reads dirty.
    injector.clean = false;
    (injector as { clean: boolean }).clean = false;
    injector.isClean = () => Promise.resolve(false);
    const report = await controller.restore();
    expect(report.verifiedClean).toBe(false);
    expect(report.failures[0]?.error).toMatch(/did not read clean/);
  });

  test("an injector that throws on apply surfaces as unsupported and registers no reset", async () => {
    const injector = new FakeInjector("faults.battery");
    injector.failApply = true;
    const controller = controllerWith(
      new Map<DeviceConditionKey, DeviceConditionInjector>([["faults.battery", injector]]),
    );
    const result = await controller.apply({ faults: { battery: "unplug" } });
    expect(result.success).toBe(false);
    expect(result.changes[0]).toMatchObject({ key: "faults.battery", status: "unsupported" });
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("unset clears just one key's reset", async () => {
    const injector = new FakeInjector("faults.battery");
    const controller = controllerWith(
      new Map<DeviceConditionKey, DeviceConditionInjector>([["faults.battery", injector]]),
    );
    await controller.apply({ faults: { battery: "unplug" } });
    const cleared = await controller.apply({ faults: { battery: "unset" } });
    expect(cleared.changes[0]).toMatchObject({ key: "faults.battery", status: "cleared" });
    expect(injector.resetCount).toBe(1);
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("unset clears every reset registered for the key, newest first, and leaves other keys alone", async () => {
    const battery = new FakeInjector("faults.battery");
    const thermal = new FakeInjector("faults.thermal");
    const controller = controllerWith(
      new Map<DeviceConditionKey, DeviceConditionInjector>([
        ["faults.battery", battery],
        ["faults.thermal", thermal],
      ]),
    );
    // Applying a key twice can register two resets (an injector that cannot tell the controller kept one).
    await controller.apply({ faults: { battery: "unplug" } });
    await controller.apply({ faults: { thermal: "critical" } });
    await controller.apply({ faults: { battery: "low" } });

    const cleared = await controller.apply({ faults: { battery: "unset" } });
    expect(cleared.changes).toEqual([{ key: "faults.battery", status: "cleared" }]);
    expect(battery.resetCount).toBe(2);
    expect(thermal.resetCount).toBe(0);
    expect(cleared.active).toEqual(["faults.thermal"]);
  });

  test("an unset whose newest reset fails keeps every reset for the key and a retry clears them all", async () => {
    const battery = new FakeInjector("faults.battery");
    const controller = controllerWith(
      new Map<DeviceConditionKey, DeviceConditionInjector>([["faults.battery", battery]]),
    );
    await controller.apply({ faults: { battery: "unplug" } });
    await controller.apply({ faults: { battery: "low" } });

    battery.failReset = true;
    const failed = await controller.apply({ faults: { battery: "unset" } });
    expect(failed.changes[0]).toMatchObject({ key: "faults.battery", status: "unsupported" });
    // Two resets are held, but it is one active condition.
    expect(failed.active).toEqual(["faults.battery"]);

    battery.failReset = false;
    const retried = await controller.apply({ faults: { battery: "unset" } });
    expect(retried.changes).toEqual([{ key: "faults.battery", status: "cleared" }]);
    expect(retried.active).toEqual([]);
  });

  test("reset:true restores everything before applying the same request's new fields", async () => {
    const injector = new FakeInjector("faults.battery");
    const controller = controllerWith(
      new Map<DeviceConditionKey, DeviceConditionInjector>([["faults.battery", injector]]),
    );
    await controller.apply({ faults: { battery: "unplug" } });
    const result = await controller.apply({ reset: true });
    expect(result.restore?.restored).toEqual(["faults.battery"]);
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("an apply that fails with an owed reset is unsupported but still restorable", async () => {
    const injector = new FakeInjector("rootState");
    injector.failApplyWithOwedReset = true;
    const controller = controllerWith(new Map([["rootState", injector]]));
    const result = await controller.apply({ rootState: "rooted-detectable" });
    expect(result.changes[0].status).toBe("unsupported");
    expect(controller.hasActiveConditions()).toBe(true);

    const report = await controller.restore();
    expect(injector.resetCount).toBe(1);
    expect(report.verifiedClean).toBe(true);
  });
});

test("controller forwards per-signal outcomes without changing the top-level contract", async () => {
  const signals = [
    {
      id: "su-binary" as const,
      requested: "on" as const,
      status: "unsupported" as const,
      detail: "root refused",
    },
  ];
  const injector: DeviceConditionInjector = {
    key: "integrityState",
    apply: async () => ({ status: "unchanged", signals }),
    isClean: async () => true,
  };
  const result = await new DeviceConditionController(() => injector).apply({
    integrityState: "maximally-detectable",
  });
  expect(result.changes).toEqual([{ key: "integrityState", status: "unchanged", signals }]);
  expect(result.active).toEqual([]);
  expect(result.success).toBe(true);
});

test("restore verifies an outcome's own isClean instead of the injector-wide one", async () => {
  const injector: DeviceConditionInjector = {
    key: "faults.lockScreen",
    apply: async () => ({
      status: "applied",
      reset: async () => {},
      isClean: async () => true,
    }),
    isClean: async () => false,
  };
  const controller = new DeviceConditionController(() => injector, new FakeLogger());
  await controller.apply({ faults: { lockScreen: "pin" } });
  expect(await controller.restore()).toEqual({
    restored: ["faults.lockScreen"],
    failures: [],
    verifiedClean: true,
  });
});

test("restore verifies an owed reset with the isClean its OwedResetError carries", async () => {
  const injector: DeviceConditionInjector = {
    key: "faults.lockScreen",
    apply: () =>
      Promise.reject(
        new OwedResetError("half applied", async () => {}, { isClean: async () => true }),
      ),
    isClean: async () => false,
  };
  const controller = new DeviceConditionController(() => injector, new FakeLogger());
  await controller.apply({ faults: { lockScreen: "pin" } });
  expect((await controller.restore()).verifiedClean).toBe(true);
});
