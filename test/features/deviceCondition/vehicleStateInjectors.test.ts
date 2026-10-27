import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import {
  parsePropertyValue,
  resolveVehicleStateInjector,
} from "../../../src/features/deviceCondition/vehicleStateInjectors";
import { deviceConditionChanges } from "../../../src/features/deviceCondition/DeviceConditionTypes";
import { resolveIosRefusalInjector } from "../../../src/features/deviceCondition/iosRefusalInjector";

const GEAR = "0x11400400";
const SPEED = "0x11600207";
const BRAKE = "0x11200402";
const NIGHT = "0x11200407";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

/**
 * A car service holding global vehicle properties. The read format is the guess the parser is
 * written against; the AAOS spike (#14916) replaces it with a captured reply.
 */
function vehicleAdb(initial: Record<string, string>, options: { injectFails?: boolean } = {}) {
  const props = { ...initial };
  const log: string[] = [];
  const adb = new FakeAdbExecutor();
  adb.execute = (args) => {
    const command = args.join(" ");
    log.push(command);
    const get = /^shell cmd car_service get-property-value (\S+)$/.exec(command);
    if (get) {
      return Promise.resolve(execResult(`Value[int32Values: [${props[get[1]]}]]`));
    }
    const inject = /^shell cmd car_service inject-vhal-event (\S+) 0 (\S+)$/.exec(command);
    if (inject) {
      if (options.injectFails) {
        return Promise.resolve(execResult("Unknown command: inject-vhal-event"));
      }
      props[inject[1]] = inject[2];
      return Promise.resolve(execResult(""));
    }
    if (command.includes("CarDrivingStateService")) {
      return Promise.resolve(execResult("mCurrentDrivingState: driving state 2\nother"));
    }
    return Promise.resolve(execResult(""));
  };
  return { adb, props, log };
}

const PARKED = { [GEAR]: "4", [SPEED]: "0.0", [BRAKE]: "1", [NIGHT]: "0" };

const automotive: BootedDevice = {
  name: "AAOS",
  platform: "android",
  deviceId: "emulator-5554",
  formFactor: "automotive",
};

function injectorFor(
  device: BootedDevice,
  key: "vehicle.motion" | "vehicle.nightMode",
  adb: FakeAdbExecutor,
) {
  const injector = resolveVehicleStateInjector(device, key, {
    adbFactory: { create: () => adb },
    cache: new Map(),
  });
  if (!injector) {
    throw new Error("no injector");
  }
  return injector;
}

describe("vehicle state injectors (#14919)", () => {
  test("driving sets gear, speed and brake together and reports the driving state", async () => {
    const car = vehicleAdb({ ...PARKED });
    const out = await injectorFor(automotive, "vehicle.motion", car.adb).apply("driving");
    expect(out.status).toBe("applied");
    expect(car.props).toMatchObject({ [GEAR]: "8", [SPEED]: "10.0", [BRAKE]: "0" });
    expect(out.detail).toContain("driving state 2");
  });

  test("re-applying the same value is unchanged and writes nothing", async () => {
    const car = vehicleAdb({ ...PARKED });
    const injector = injectorFor(automotive, "vehicle.motion", car.adb);
    await injector.apply("driving");
    const before = car.log.filter((c) => c.includes("inject-vhal-event")).length;
    const again = await injector.apply("driving");
    expect(again.status).toBe("unchanged");
    expect(car.log.filter((c) => c.includes("inject-vhal-event")).length).toBe(before);
  });

  test("release restores the values read before the first change, across value switches", async () => {
    const car = vehicleAdb({ ...PARKED });
    const injector = injectorFor(automotive, "vehicle.motion", car.adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ vehicle: { motion: "driving" } });
    await controller.apply({ vehicle: { motion: "parked" } });
    await controller.apply({ vehicle: { motion: "driving" } });
    expect(controller.activeKeys()).toEqual(["vehicle.motion"]);
    const report = await controller.restore();
    expect(report.verifiedClean).toBe(true);
    expect(car.props).toMatchObject({ [GEAR]: "4", [SPEED]: "0.0", [BRAKE]: "1" });
  });

  test("unset clears the key and restores the prior night mode", async () => {
    const car = vehicleAdb({ ...PARKED });
    const injector = injectorFor(automotive, "vehicle.nightMode", car.adb);
    const controller = new DeviceConditionController(() => injector);
    const applied = await controller.apply({ vehicle: { nightMode: "on" } });
    expect(applied.changes[0].status).toBe("applied");
    expect(car.props[NIGHT]).toBe("1");
    const cleared = await controller.apply({ vehicle: { nightMode: "unset" } });
    expect(cleared.changes[0].status).toBe("cleared");
    expect(car.props[NIGHT]).toBe("0");
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("a target equal to the current state registers nothing to restore", async () => {
    const car = vehicleAdb({ ...PARKED });
    const out = await injectorFor(automotive, "vehicle.nightMode", car.adb).apply("off");
    expect(out.status).toBe("unchanged");
    expect(out.reset).toBeUndefined();
  });

  test("a phone is unsupported and issues no car service command", async () => {
    const car = vehicleAdb({ ...PARKED });
    const phone: BootedDevice = { ...automotive, formFactor: "phone" };
    await expect(injectorFor(phone, "vehicle.motion", car.adb).apply("driving")).rejects.toThrow(
      /unsupported.*not one/,
    );
    expect(car.log).toEqual([]);
  });

  test("a physical head unit is unsupported", async () => {
    const car = vehicleAdb({ ...PARKED });
    const physical: BootedDevice = { ...automotive, deviceId: "R58M123ABC" };
    await expect(injectorFor(physical, "vehicle.motion", car.adb).apply("parked")).rejects.toThrow(
      /emulators only/,
    );
  });

  test("an unreadable property fails closed before any write", async () => {
    const car = vehicleAdb({ ...PARKED });
    car.props[GEAR] = "";
    car.adb.execute = () => Promise.resolve(execResult("no value"));
    await expect(
      injectorFor(automotive, "vehicle.motion", car.adb).apply("driving"),
    ).rejects.toThrow(/could not read vehicle property/);
  });

  test("a rejected inject surfaces as unsupported and owes the restore", async () => {
    const car = vehicleAdb({ ...PARKED }, { injectFails: true });
    const controller = new DeviceConditionController(() =>
      injectorFor(automotive, "vehicle.motion", car.adb),
    );
    const result = await controller.apply({ vehicle: { motion: "driving" } });
    expect(result.changes[0].status).toBe("unsupported");
    expect(controller.hasActiveConditions()).toBe(true);
  });

  test("an invalid value is rejected", async () => {
    const car = vehicleAdb({ ...PARKED });
    await expect(
      injectorFor(automotive, "vehicle.motion", car.adb).apply("flying"),
    ).rejects.toThrow(/Expected one of: parked, driving/);
  });

  test("only vehicle keys on Android resolve", () => {
    const { adb } = vehicleAdb({});
    const deps = { adbFactory: { create: () => adb }, cache: new Map() };
    expect(resolveVehicleStateInjector(automotive, "faults.battery", deps)).toBeUndefined();
    expect(
      resolveVehicleStateInjector({ ...automotive, platform: "ios" }, "vehicle.motion", deps),
    ).toBeUndefined();
  });

  test("iOS refuses vehicle keys by name", async () => {
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "UDID" };
    await expect(
      resolveIosRefusalInjector(ios, "vehicle.motion")?.apply("driving"),
    ).rejects.toThrow(/unsupported on iOS Simulator/);
  });

  test("the request splits into vehicle changes", () => {
    expect(deviceConditionChanges({ vehicle: { nightMode: "on", motion: "unset" } })).toEqual([
      { key: "vehicle.motion", value: "unset" },
      { key: "vehicle.nightMode", value: "on" },
    ]);
  });

  test("parses the first numeric value of a read", () => {
    expect(parsePropertyValue("Value[floatValues: [3.5]]")).toBe("3.5");
    expect(parsePropertyValue("nothing here")).toBeUndefined();
  });
});
