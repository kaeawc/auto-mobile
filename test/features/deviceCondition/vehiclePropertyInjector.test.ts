import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import type { DeviceTraits } from "../../../src/utils/android-cmdline-tools/deviceTraits";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { resolveVehicleStateInjector } from "../../../src/features/deviceCondition/vehicleStateInjectors";
import {
  deviceConditionChanges,
  deviceConditionInputSchema,
} from "../../../src/features/deviceCondition/DeviceConditionTypes";
import { resolveIosRefusalInjector } from "../../../src/features/deviceCondition/iosRefusalInjector";

const GEAR = 0x11400400;
const BRAKE = 0x11200402;
const FUEL = 0x11600307;
const HVAC_TEMP = 0x15600503;

function execResult(stdout: string, error?: string): ExecResult {
  return {
    stdout,
    stderr: "",
    ...(error ? { error } : {}),
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

/** The value field a property id's type stores its value in. */
function rawValues(id: number, value: string): string {
  const type = id & 0x00ff0000;
  const int32 = type === 0x00200000 || type === 0x00400000 ? value : "";
  const float = type === 0x00600000 ? value : "";
  return `int32Values: [${int32}], floatValues: [${float}], int64Values: [], byteValues: [], stringValue: `;
}

/**
 * A car service over a VHAL store keyed `id:area`. Stock CarService injection dispatches the
 * event without writing the store; `injectWritesStore` stands in for a VHAL that reflects it.
 */
function carService(
  store: Record<string, string>,
  options: { injectWritesStore?: boolean; injectReply?: string } = {},
) {
  const log: string[] = [];
  const events: string[] = [];
  const adb = new FakeAdbExecutor();
  adb.execute = (args) => {
    const command = args.join(" ");
    log.push(command);
    const get = /^shell cmd car_service get-property-value (0x[0-9a-f]+) (\d+)$/.exec(command);
    if (get) {
      const id = Number(get[1]);
      const value = store[`${id}:${get[2]}`];
      return Promise.resolve(
        execResult(
          value === undefined
            ? `Can not get property value for property: ${id} // ${get[1]} in areaId: ${get[2]} // 0x0.`
            : `android.hardware.automotive.vehicle.VehiclePropValue{timestamp: 1, areaId: ${get[2]}, prop: ${id}, status: 0, value: android.hardware.automotive.vehicle.RawPropValues{${rawValues(id, value)}}}`,
        ),
      );
    }
    const inject = /^shell cmd car_service inject-vhal-event (0x[0-9a-f]+) (\d+) (\S+)$/.exec(
      command,
    );
    if (inject) {
      events.push(`${inject[1]} ${inject[2]} ${inject[3]}`);
      if (options.injectWritesStore) {
        const value = inject[3] === "true" ? "1" : inject[3] === "false" ? "0" : inject[3];
        store[`${Number(inject[1])}:${inject[2]}`] = value;
      }
      return Promise.resolve(execResult(options.injectReply ?? ""));
    }
    return Promise.resolve(execResult(""));
  };
  return { adb, log, events, store };
}

const automotive: BootedDevice = { name: "AAOS", platform: "android", deviceId: "emulator-5554" };

function traitsOf(formFactor: "automotive" | null, isEmulator = true): DeviceTraits {
  return {
    read: () =>
      Promise.resolve({
        isEmulator,
        model: null,
        sdk: 34,
        abi: null,
        manufacturer: null,
        brand: null,
        skin: null,
        formFactor,
      }),
  };
}

function propertyInjector(adb: FakeAdbExecutor, traits = traitsOf("automotive")) {
  const injector = resolveVehicleStateInjector(automotive, "vehicle.property", {
    adbFactory: { create: () => adb },
    cache: new Map(),
    traits,
  });
  if (!injector) {
    throw new Error("no injector");
  }
  return injector;
}

describe("vehicle.property (#19058)", () => {
  test("injects by name and reports the read-back, with the exact command lines", async () => {
    const car = carService({ [`${GEAR}:0`]: "4" });
    const controller = new DeviceConditionController(() => propertyInjector(car.adb));
    const result = await controller.apply({
      vehicle: { property: { id: "GEAR_SELECTION", value: 8 } },
    });
    expect(car.log).toEqual([
      "shell cmd car_service get-property-value 0x11400400 0",
      "shell cmd car_service inject-vhal-event 0x11400400 0 8",
      "shell cmd car_service get-property-value 0x11400400 0",
    ]);
    expect(result.changes).toEqual([
      {
        key: "vehicle.property",
        status: "applied",
        vehicleProperty: {
          id: "0x11400400",
          name: "GEAR_SELECTION",
          areaId: 0,
          type: "INT32",
          value: "8",
          readBack: "4",
          matches: false,
        },
        detail:
          "vehicle property GEAR_SELECTION (0x11400400) injected 8; get-property-value reads 4 (inject-vhal-event does not write the VHAL store)",
      },
    ]);
    expect(controller.activeKeys()).toEqual(["vehicle.property"]);
  });

  test("a VHAL that reflects the event reads back the injected value", async () => {
    const car = carService({ [`${FUEL}:0`]: "40000.0" }, { injectWritesStore: true });
    const result = await propertyInjector(car.adb).apply("apply", undefined, {
      id: "0x11600307",
      value: 12500.5,
    });
    expect(result.vehicleProperty).toMatchObject({
      name: "FUEL_LEVEL",
      value: "12500.5",
      readBack: "12500.5",
      matches: true,
    });
    expect(result.detail).toBe(
      "vehicle property FUEL_LEVEL (0x11600307) injected 12500.5; get-property-value reads 12500.5",
    );
  });

  test("a zoned property passes its area to both commands; a decimal id resolves its name", async () => {
    const car = carService({ [`${HVAC_TEMP}:1`]: "20.0" });
    const result = await propertyInjector(car.adb).apply("apply", undefined, {
      id: String(HVAC_TEMP),
      areaId: "0x1",
      value: 22.5,
    });
    expect(car.log).toEqual([
      "shell cmd car_service get-property-value 0x15600503 1",
      "shell cmd car_service inject-vhal-event 0x15600503 1 22.5",
      "shell cmd car_service get-property-value 0x15600503 1",
    ]);
    expect(result.vehicleProperty).toMatchObject({ name: "HVAC_TEMPERATURE_SET", areaId: 1 });
  });

  test("a BOOLEAN property is injected as true/false, which inject-vhal-event parses", async () => {
    const car = carService({ [`${BRAKE}:0`]: "0" });
    const result = await propertyInjector(car.adb).apply("apply", undefined, {
      id: BRAKE,
      value: true,
    });
    expect(car.events).toEqual(["0x11200402 0 true"]);
    expect(result.vehicleProperty).toMatchObject({ value: "true", readBack: "false" });
  });

  test("reset re-injects each property's first baseline, newest first, and verifies clean", async () => {
    const car = carService({ [`${GEAR}:0`]: "4", [`${BRAKE}:0`]: "1" });
    const injector = propertyInjector(car.adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ vehicle: { property: { id: "GEAR_SELECTION", value: 8 } } });
    await controller.apply({ vehicle: { property: { id: "PARKING_BRAKE_ON", value: false } } });
    await controller.apply({ vehicle: { property: { id: "GEAR_SELECTION", value: 2 } } });
    const report = await controller.restore();
    expect(report.verifiedClean).toBe(true);
    expect(car.events).toEqual([
      "0x11400400 0 8",
      "0x11200402 0 false",
      "0x11400400 0 2",
      "0x11200402 0 true",
      "0x11400400 0 4",
    ]);
  });

  test("unset restores the baselines and clears the key", async () => {
    const car = carService({ [`${GEAR}:0`]: "4" });
    const controller = new DeviceConditionController(() => propertyInjector(car.adb));
    await controller.apply({ vehicle: { property: { id: "GEAR_SELECTION", value: 8 } } });
    const cleared = await controller.apply({ vehicle: { property: "unset" } });
    expect(cleared.changes[0]).toMatchObject({ key: "vehicle.property", status: "cleared" });
    expect(car.events.at(-1)).toBe("0x11400400 0 4");
    expect(controller.activeKeys()).toEqual([]);
  });

  test("an unreadable property fails closed before any inject", async () => {
    const car = carService({});
    const controller = new DeviceConditionController(() => propertyInjector(car.adb));
    const result = await controller.apply({
      vehicle: { property: { id: "EV_BATTERY_LEVEL", value: 50 } },
    });
    expect(result.changes[0].status).toBe("unsupported");
    expect(result.changes[0].detail).toContain(
      "could not read vehicle property EV_BATTERY_LEVEL (0x11600309): Can not get property value",
    );
    expect(car.events).toEqual([]);
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("a rejected inject is unsupported and owes nothing", async () => {
    const car = carService(
      { [`${GEAR}:0`]: "4" },
      { injectReply: "Property area type inconsistent with given zone: 0" },
    );
    const controller = new DeviceConditionController(() => propertyInjector(car.adb));
    const result = await controller.apply({
      vehicle: { property: { id: "GEAR_SELECTION", value: 8 } },
    });
    expect(result.changes[0].status).toBe("unsupported");
    expect(result.changes[0].detail).toContain(
      "`inject-vhal-event 0x11400400` failed: Property area type inconsistent",
    );
    expect(controller.hasActiveConditions()).toBe(false);
  });

  test("a user build refuses with the vehicle.property reason before any inject", async () => {
    const car = carService({ [`${GEAR}:0`]: "4" });
    car.adb.execute = () =>
      Promise.resolve(
        execResult(
          "",
          "java.lang.SecurityException: The command 'get-property-value' requires non-user build",
        ),
      );
    const controller = new DeviceConditionController(() => propertyInjector(car.adb));
    const result = await controller.apply({
      vehicle: { property: { id: "GEAR_SELECTION", value: 8 } },
    });
    expect(result.changes[0].status).toBe("unsupported");
    expect(result.changes[0].detail).toContain(
      "this AAOS image is a user build; vehicle.property needs a userdebug/eng image",
    );
    expect(car.events).toEqual([]);
  });

  test("a phone and a physical head unit are refused without a car service command", async () => {
    const phone = carService({});
    await expect(
      propertyInjector(phone.adb, traitsOf(null)).apply("apply", undefined, {
        id: "GEAR_SELECTION",
        value: 8,
      }),
    ).rejects.toThrow("vehicle.property needs an Android Automotive emulator");
    const headUnit = carService({});
    await expect(
      propertyInjector(headUnit.adb, traitsOf("automotive", false)).apply("apply", undefined, {
        id: "GEAR_SELECTION",
        value: 8,
      }),
    ).rejects.toThrow("injected on emulators only");
    expect([...phone.log, ...headUnit.log]).toEqual([]);
  });

  test("invalid requests are refused before reading the device", async () => {
    const car = carService({});
    let traitReads = 0;
    const injector = propertyInjector(car.adb, {
      read: (...args) => {
        traitReads++;
        return traitsOf("automotive").read(...args);
      },
    });
    await expect(injector.apply("on")).rejects.toThrow("expected { id, areaId?, value }");
    await expect(injector.apply("apply", undefined, { id: "GEAR_SELECTION" })).rejects.toThrow(
      "(value: Invalid input)",
    );
    await expect(
      injector.apply("apply", undefined, { id: "GEAR_SELECTION", value: 8.5 }),
    ).rejects.toThrow("expected a 32-bit integer");
    await expect(
      injector.apply("apply", undefined, { id: "HVAC_TEMPERATURE_SET", value: 21 }),
    ).rejects.toThrow("SEAT-area property; pass the areaId");
    await expect(injector.apply("apply", undefined, { id: 0x11100a00, value: 1 })).rejects.toThrow(
      "only injects BOOLEAN, INT32, INT64 and FLOAT",
    );
    expect(traitReads).toBe(0);
    expect(car.log).toEqual([]);
  });

  test("the tool schema accepts names, numeric ids and vectors, and rejects unknown names", () => {
    const parse = (property: unknown) =>
      deviceConditionInputSchema.safeParse({ vehicle: { property } }).success;
    expect(parse({ id: "GEAR_SELECTION", value: 8 })).toBe(true);
    expect(parse({ id: "0x11400400", value: 8 })).toBe(true);
    expect(parse({ id: 289408000, areaId: 0, value: 8 })).toBe(true);
    expect(parse({ id: "HVAC_TEMPERATURE_SET", areaId: "0x1", value: 21.5 })).toBe(true);
    expect(parse({ id: "0x11410a00", value: [1, 2] })).toBe(true);
    expect(parse({ id: "PARKING_BRAKE_ON", value: true })).toBe(true);
    expect(parse("unset")).toBe(true);
    expect(parse({ id: "NOT_A_PROPERTY", value: 1 })).toBe(false);
    expect(parse({ id: "GEAR_SELECTION" })).toBe(false);
    expect(parse({ id: "GEAR_SELECTION", value: "8" })).toBe(false);
    expect(parse({ id: "GEAR_SELECTION", value: 8, extra: 1 })).toBe(false);
    expect(parse({ id: "GEAR_SELECTION", value: [] })).toBe(false);
  });

  test("the request splits into a parameterized vehicle.property change", () => {
    expect(
      deviceConditionChanges({
        vehicle: { property: { id: "FUEL_LEVEL", value: 1000 }, nightMode: "on" },
      }),
    ).toEqual([
      { key: "vehicle.nightMode", value: "on" },
      { key: "vehicle.property", value: "apply", params: { id: "FUEL_LEVEL", value: 1000 } },
    ]);
  });

  test("iOS refuses vehicle.property by name", async () => {
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "UDID" };
    await expect(
      resolveIosRefusalInjector(ios, "vehicle.property")?.apply("apply"),
    ).rejects.toThrow(/unsupported on iOS Simulator/);
  });
});
