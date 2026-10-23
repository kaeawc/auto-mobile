import { describe, expect, test } from "bun:test";
import {
  DeviceConditionController,
  type DeviceConditionInjector,
  type DeviceConditionApplyOutcome,
} from "../../../src/features/deviceCondition/DeviceConditionController";
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
  return new DeviceConditionController((key) => injectors.get(key));
}

describe("DeviceConditionController (#14050)", () => {
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
