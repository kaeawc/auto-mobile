import { describe, expect, test } from "bun:test";
import { resolveIosRefusalInjector } from "../../../src/features/deviceCondition/iosRefusalInjector";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import type { BootedDevice } from "../../../src/models";
import type { DeviceConditionKey } from "../../../src/features/deviceCondition/DeviceConditionTypes";

const ios: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "SIM-UDID" };
const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

describe("iOS refusals (#14073)", () => {
  test("a root or integrity request on iOS names the missing bootloader and jailbreak", async () => {
    const injector = resolveIosRefusalInjector(ios, "rootState");
    expect(injector).toBeDefined();
    await expect(injector?.apply("rooted-detectable")).rejects.toThrow(
      /unsupported on iOS Simulator.*jailbroken/,
    );
    expect(resolveIosRefusalInjector(ios, "integrityState")).toBeDefined();
  });

  test("each Android-only fault is refused on iOS with an Android pointer", async () => {
    for (const key of [
      "faults.lowPower",
      "faults.doze",
      "faults.thermal",
      "faults.dontKeepActivities",
      "faults.storage",
    ] satisfies DeviceConditionKey[]) {
      const injector = resolveIosRefusalInjector(ios, key);
      await expect(injector?.apply("on")).rejects.toThrow(/Android device or emulator/);
    }
  });

  test("an Android device, or a key iOS can satisfy, falls through", () => {
    expect(resolveIosRefusalInjector(android, "rootState")).toBeUndefined();
    expect(resolveIosRefusalInjector(ios, "faults.battery")).toBeUndefined();
  });

  test("through the controller the refusal is reported unsupported and owes no reset", async () => {
    const controller = new DeviceConditionController((key) => resolveIosRefusalInjector(ios, key));
    const result = await controller.apply({ rootState: "rooted-detectable" });
    expect(result.success).toBe(false);
    expect(result.changes[0]).toMatchObject({ key: "rootState", status: "unsupported" });
    expect(result.changes[0].detail).toContain("jailbroken");
    expect(result.active).toEqual([]);
  });
});
