import { describe, expect, test } from "bun:test";
import {
  VEHICLE_PROPERTY_IDS,
  encodeVehiclePropertyValue,
  parseVehiclePropertyReadback,
  resolveVehiclePropertyId,
  resolveVehiclePropertyTarget,
  sameVehiclePropertyValue,
} from "../../../src/features/deviceCondition/vehicleProperties";

/** `get-property-value <id> <areaId>` on an AIDL VHAL: the generated `VehiclePropValue.toString()`. */
function aidlReply(
  prop: number,
  areaId: number,
  raw: { int32?: string; float?: string; int64?: string },
) {
  return (
    `android.hardware.automotive.vehicle.VehiclePropValue{timestamp: 123456789, areaId: ${areaId}, ` +
    `prop: ${prop}, status: 0, value: android.hardware.automotive.vehicle.RawPropValues{` +
    `int32Values: [${raw.int32 ?? ""}], floatValues: [${raw.float ?? ""}], ` +
    `int64Values: [${raw.int64 ?? ""}], byteValues: [], stringValue: }}`
  );
}

describe("VehicleProperty name table (#19058)", () => {
  test("matches the ids VehicleProperty.aidl defines", () => {
    expect(VEHICLE_PROPERTY_IDS).toEqual({
      GEAR_SELECTION: 0x11400400,
      PERF_VEHICLE_SPEED: 0x11600207,
      PARKING_BRAKE_ON: 0x11200402,
      IGNITION_STATE: 0x11400409,
      FUEL_LEVEL: 0x11600307,
      EV_BATTERY_LEVEL: 0x11600309,
      HVAC_TEMPERATURE_SET: 0x15600503,
      TURN_SIGNAL_STATE: 0x11400408,
      NIGHT_MODE: 0x11200407,
    });
  });

  test("resolves names, decimal and 0x hex ids to the same number", () => {
    expect(resolveVehiclePropertyId("GEAR_SELECTION")).toBe(0x11400400);
    expect(resolveVehiclePropertyId("0x11400400")).toBe(0x11400400);
    expect(resolveVehiclePropertyId("0X11400400")).toBe(0x11400400);
    expect(resolveVehiclePropertyId("289408000")).toBe(0x11400400);
    expect(resolveVehiclePropertyId(289408000)).toBe(0x11400400);
  });

  test("rejects unknown names, out-of-range and malformed ids", () => {
    expect(() => resolveVehiclePropertyId("NOT_A_PROPERTY")).toThrow(
      "Unknown VehicleProperty name 'NOT_A_PROPERTY'",
    );
    expect(() => resolveVehiclePropertyId("0x80000000")).toThrow("0 to 0x7fffffff");
    expect(() => resolveVehiclePropertyId(-1)).toThrow("0 to 0x7fffffff");
    expect(() => resolveVehiclePropertyId(1.5)).toThrow("0 to 0x7fffffff");
    expect(() => resolveVehiclePropertyId("toString")).toThrow("Unknown VehicleProperty name");
  });
});

describe("vehicle property targets", () => {
  test("a global property takes area 0 and reports its name, hex id and type", () => {
    expect(resolveVehiclePropertyTarget("FUEL_LEVEL")).toEqual({
      id: 0x11600307,
      hexId: "0x11600307",
      name: "FUEL_LEVEL",
      areaId: 0,
      type: "FLOAT",
    });
    expect(resolveVehiclePropertyTarget("0x11600307", 0).areaId).toBe(0);
  });

  test("a global property refuses a non-zero area, and a zoned one needs an area", () => {
    expect(() => resolveVehiclePropertyTarget("GEAR_SELECTION", 1)).toThrow(
      "GEAR_SELECTION (0x11400400) is a global property",
    );
    expect(() => resolveVehiclePropertyTarget("HVAC_TEMPERATURE_SET")).toThrow(
      "is a SEAT-area property; pass the areaId",
    );
    expect(resolveVehiclePropertyTarget("HVAC_TEMPERATURE_SET", "0x1")).toMatchObject({
      areaId: 1,
      type: "FLOAT",
    });
  });

  test("an id outside the table resolves without a name", () => {
    const target = resolveVehiclePropertyTarget(0x25400a00, 0x4);
    expect(target.name).toBeUndefined();
    expect(target).toMatchObject({ hexId: "0x25400a00", areaId: 4, type: "INT32" });
  });
});

describe("vehicle property value encoding", () => {
  test("BOOLEAN encodes true/false, the only spellings Boolean.parseBoolean reads as set", () => {
    const brake = resolveVehiclePropertyTarget("PARKING_BRAKE_ON");
    expect(encodeVehiclePropertyValue(brake, true)).toBe("true");
    expect(encodeVehiclePropertyValue(brake, false)).toBe("false");
    expect(encodeVehiclePropertyValue(brake, 1)).toBe("true");
    expect(encodeVehiclePropertyValue(brake, 0)).toBe("false");
    expect(() => encodeVehiclePropertyValue(brake, 2)).toThrow("expected true, false, 1 or 0");
    expect(() => encodeVehiclePropertyValue(brake, [1])).toThrow("expected true, false, 1 or 0");
  });

  test("INT32 needs one 32-bit integer; FLOAT one finite number", () => {
    const gear = resolveVehiclePropertyTarget("GEAR_SELECTION");
    expect(encodeVehiclePropertyValue(gear, 8)).toBe("8");
    expect(() => encodeVehiclePropertyValue(gear, 8.5)).toThrow("a 32-bit integer");
    expect(() => encodeVehiclePropertyValue(gear, 0x80000000)).toThrow("a 32-bit integer");
    expect(() => encodeVehiclePropertyValue(gear, [4, 8])).toThrow("a 32-bit integer");
    expect(() => encodeVehiclePropertyValue(gear, true)).toThrow("a 32-bit integer");
    const fuel = resolveVehiclePropertyTarget("FUEL_LEVEL");
    expect(encodeVehiclePropertyValue(fuel, 12500.5)).toBe("12500.5");
    expect(encodeVehiclePropertyValue(fuel, 0)).toBe("0");
  });

  test("vector types take an array, comma-separated as inject-vhal-event splits it", () => {
    const int32Vec = resolveVehiclePropertyTarget(0x11410a00);
    expect(int32Vec.type).toBe("INT32_VEC");
    expect(encodeVehiclePropertyValue(int32Vec, [1, -2, 3])).toBe("1,-2,3");
    expect(encodeVehiclePropertyValue(int32Vec, 7)).toBe("7");
    const floatVec = resolveVehiclePropertyTarget(0x11610a00);
    expect(encodeVehiclePropertyValue(floatVec, [0.5, 1])).toBe("0.5,1");
    const int64 = resolveVehiclePropertyTarget(0x11500a00);
    expect(encodeVehiclePropertyValue(int64, 2 ** 40)).toBe("1099511627776");
  });

  test("STRING, BYTES and MIXED properties are refused: inject-vhal-event cannot carry them", () => {
    for (const id of [0x11100a00, 0x11700a00, 0x11e00a00]) {
      expect(() => encodeVehiclePropertyValue(resolveVehiclePropertyTarget(id), 1)).toThrow(
        "only injects BOOLEAN, INT32, INT64 and FLOAT values",
      );
    }
  });
});

describe("get-property-value read-back parsing", () => {
  test("reads the array the property's type uses from an AIDL VHAL reply", () => {
    const gear = resolveVehiclePropertyTarget("GEAR_SELECTION");
    expect(parseVehiclePropertyReadback(gear, aidlReply(gear.id, 0, { int32: "4" }))).toBe("4");
    const speed = resolveVehiclePropertyTarget("PERF_VEHICLE_SPEED");
    expect(parseVehiclePropertyReadback(speed, aidlReply(speed.id, 0, { float: "10.0" }))).toBe(
      "10.0",
    );
    const hvac = resolveVehiclePropertyTarget("HVAC_TEMPERATURE_SET", 1);
    expect(parseVehiclePropertyReadback(hvac, aidlReply(hvac.id, 1, { float: "21.5" }))).toBe(
      "21.5",
    );
    const vec = resolveVehiclePropertyTarget(0x11410a00);
    expect(parseVehiclePropertyReadback(vec, aidlReply(vec.id, 0, { int32: "1, 2, 3" }))).toBe(
      "1,2,3",
    );
    const int64 = resolveVehiclePropertyTarget(0x11500a00);
    expect(parseVehiclePropertyReadback(int64, aidlReply(int64.id, 0, { int64: "42" }))).toBe("42");
  });

  test("reports a BOOLEAN read-back as true/false and reads the HIDL spelling too", () => {
    const brake = resolveVehiclePropertyTarget("PARKING_BRAKE_ON");
    expect(parseVehiclePropertyReadback(brake, aidlReply(brake.id, 0, { int32: "1" }))).toBe(
      "true",
    );
    expect(
      parseVehiclePropertyReadback(brake, "{.prop = 287310850, .value = {.int32Values = [0]}}"),
    ).toBe("false");
  });

  test("is undefined when the reply carries no value for the type", () => {
    const gear = resolveVehiclePropertyTarget("GEAR_SELECTION");
    expect(parseVehiclePropertyReadback(gear, aidlReply(gear.id, 0, { float: "1.0" }))).toBe(
      undefined,
    );
    expect(
      parseVehiclePropertyReadback(
        gear,
        "Can not get property value for property: 289408000 // 0x11400400 in areaId: 0 // 0x0.",
      ),
    ).toBeUndefined();
  });

  test("compares encoded values numerically per element", () => {
    expect(sameVehiclePropertyValue("10.0", "10")).toBe(true);
    expect(sameVehiclePropertyValue("1,2", "1.0,2")).toBe(true);
    expect(sameVehiclePropertyValue("true", "true")).toBe(true);
    expect(sameVehiclePropertyValue("true", "false")).toBe(false);
    expect(sameVehiclePropertyValue("1,2", "1")).toBe(false);
  });
});
