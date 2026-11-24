import { ActionableError } from "../../models/ActionableError";

/**
 * Vehicle HAL property ids, names and value encoding for `deviceCondition.vehicle.property`.
 *
 * Ids are `group | area | type | index`, from AOSP `hardware/interfaces/automotive/vehicle/aidl_property/
 * android/hardware/automotive/vehicle/VehicleProperty.aidl` (android14-release), which spells each one
 * as the same four-term sum. `cmd car_service inject-vhal-event` parses values by the id's type bits
 * (`VehicleHal.createPropValueForInjecting`): BOOLEAN with `Boolean.parseBoolean`, INT32/INT64 with
 * `Integer.decode`/`Long.decode`, FLOAT with `Float.parseFloat`, vectors comma-separated. It has no
 * path for STRING, BYTES or MIXED.
 */

/** Common `VehicleProperty` names and their ids (VehicleProperty.aidl, android14-release). */
export const VEHICLE_PROPERTY_IDS = {
  GEAR_SELECTION: 0x0400 + 0x10000000 + 0x01000000 + 0x00400000,
  PERF_VEHICLE_SPEED: 0x0207 + 0x10000000 + 0x01000000 + 0x00600000,
  PARKING_BRAKE_ON: 0x0402 + 0x10000000 + 0x01000000 + 0x00200000,
  IGNITION_STATE: 0x0409 + 0x10000000 + 0x01000000 + 0x00400000,
  FUEL_LEVEL: 0x0307 + 0x10000000 + 0x01000000 + 0x00600000,
  EV_BATTERY_LEVEL: 0x0309 + 0x10000000 + 0x01000000 + 0x00600000,
  HVAC_TEMPERATURE_SET: 0x0503 + 0x10000000 + 0x05000000 + 0x00600000,
  TURN_SIGNAL_STATE: 0x0408 + 0x10000000 + 0x01000000 + 0x00400000,
  NIGHT_MODE: 0x0407 + 0x10000000 + 0x01000000 + 0x00200000,
} as const;

export type VehiclePropertyName = keyof typeof VEHICLE_PROPERTY_IDS;

export const VEHICLE_PROPERTY_NAMES = Object.keys(VEHICLE_PROPERTY_IDS) as [
  VehiclePropertyName,
  ...VehiclePropertyName[],
];

/** A decimal or `0x` hex number, as `Integer.decode` reads a property or area id. */
export const VEHICLE_NUMERIC_ID_PATTERN = /^(?:0[xX][0-9A-Fa-f]{1,8}|\d{1,10})$/;

/** Ids and area ids are Java ints on the device; `Integer.decode` refuses anything larger. */
export const VEHICLE_MAX_ID = 0x7fffffff;

const AREA_MASK = 0x0f000000;
const AREA_GLOBAL = 0x01000000;
const TYPE_MASK = 0x00ff0000;

/** `VehiclePropertyType` values (VehiclePropertyType.aidl). */
const PROPERTY_TYPES: Readonly<Record<number, string>> = {
  0x00100000: "STRING",
  0x00200000: "BOOLEAN",
  0x00400000: "INT32",
  0x00410000: "INT32_VEC",
  0x00500000: "INT64",
  0x00510000: "INT64_VEC",
  0x00600000: "FLOAT",
  0x00610000: "FLOAT_VEC",
  0x00700000: "BYTES",
  0x00e00000: "MIXED",
};

/** `VehicleArea` values (VehicleArea.aidl). */
const AREA_TYPES: Readonly<Record<number, string>> = {
  0x01000000: "GLOBAL",
  0x03000000: "WINDOW",
  0x04000000: "MIRROR",
  0x05000000: "SEAT",
  0x06000000: "DOOR",
  0x07000000: "WHEEL",
  0x08000000: "VENDOR",
};

export type VehiclePropertyValue = number | boolean | number[];

/** A resolved property and area, ready for the car service shell commands. */
export interface VehiclePropertyTarget {
  id: number;
  /** `0x`-prefixed lower-case hex, as the shell commands are given it. */
  hexId: string;
  name?: VehiclePropertyName;
  areaId: number;
  type: string;
}

const NAMES_BY_ID = new Map<number, VehiclePropertyName>(
  VEHICLE_PROPERTY_NAMES.map((name) => [VEHICLE_PROPERTY_IDS[name], name]),
);

function decodeId(input: number | string, field: string): number {
  const id =
    typeof input === "number"
      ? input
      : VEHICLE_NUMERIC_ID_PATTERN.test(input)
        ? Number(input)
        : Number.NaN;
  if (!Number.isInteger(id) || id < 0 || id > VEHICLE_MAX_ID) {
    throw new ActionableError(
      `Invalid vehicle.property ${field} '${input}': expected a decimal or 0x hex integer from 0 to 0x7fffffff.`,
    );
  }
  return id;
}

/** The property id for a name from {@link VEHICLE_PROPERTY_IDS}, or a decimal or 0x hex id. */
export function resolveVehiclePropertyId(input: number | string): number {
  if (typeof input === "string" && Object.hasOwn(VEHICLE_PROPERTY_IDS, input)) {
    return VEHICLE_PROPERTY_IDS[input as VehiclePropertyName];
  }
  if (typeof input === "string" && !VEHICLE_NUMERIC_ID_PATTERN.test(input)) {
    throw new ActionableError(
      `Unknown VehicleProperty name '${input}'. Use one of ${VEHICLE_PROPERTY_NAMES.join(", ")}, or pass the numeric id from VehicleProperty.aidl.`,
    );
  }
  return decodeId(input, "id");
}

/** Resolve the id and check the area against the property's area type: global is area 0 only. */
export function resolveVehiclePropertyTarget(
  id: number | string,
  areaId?: number | string,
): VehiclePropertyTarget {
  const propertyId = resolveVehiclePropertyId(id);
  const name = NAMES_BY_ID.get(propertyId);
  const hexId = `0x${propertyId.toString(16)}`;
  const label = name ? `${name} (${hexId})` : hexId;
  const area = areaId === undefined ? 0 : decodeId(areaId, "areaId");
  const areaType = propertyId & AREA_MASK;
  if (areaType === AREA_GLOBAL && area !== 0) {
    throw new ActionableError(`${label} is a global property; omit areaId or pass 0.`);
  }
  if (areaType !== AREA_GLOBAL && area === 0) {
    const kind = AREA_TYPES[areaType] ?? `0x${areaType.toString(16)}`;
    throw new ActionableError(
      `${label} is a ${kind}-area property; pass the areaId to set, e.g. 0x1 for the first row's left seat.`,
    );
  }
  const type =
    PROPERTY_TYPES[propertyId & TYPE_MASK] ?? `0x${(propertyId & TYPE_MASK).toString(16)}`;
  return { id: propertyId, hexId, ...(name ? { name } : {}), areaId: area, type };
}

/** How a target names itself in results and errors. */
export function vehiclePropertyLabel(target: VehiclePropertyTarget): string {
  const base = target.name ? `${target.name} (${target.hexId})` : target.hexId;
  return target.areaId === 0 ? base : `${base} area 0x${target.areaId.toString(16)}`;
}

function invalidValue(
  target: VehiclePropertyTarget,
  value: VehiclePropertyValue,
  expected: string,
) {
  return new ActionableError(
    `Invalid value ${JSON.stringify(value)} for ${vehiclePropertyLabel(target)} (${target.type}): expected ${expected}.`,
  );
}

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

function encodeBoolean(target: VehiclePropertyTarget, value: VehiclePropertyValue): string {
  if (typeof value === "boolean") {
    return String(value);
  }
  if (value === 0 || value === 1) {
    return String(value === 1);
  }
  throw invalidValue(target, value, "true, false, 1 or 0");
}

function encodeNumbers(
  target: VehiclePropertyTarget,
  value: VehiclePropertyValue,
  { vector, check, expected }: { vector: boolean; check: (n: number) => boolean; expected: string },
): string {
  const values = Array.isArray(value) ? value : [value];
  if (
    (Array.isArray(value) && !vector) ||
    values.length === 0 ||
    !values.every((n) => typeof n === "number" && check(n))
  ) {
    throw invalidValue(target, value, vector ? `${expected}, or an array of them` : expected);
  }
  return values.map(String).join(",");
}

const isInt32 = (n: number) => Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX;
const isSafeInteger = (n: number) => Number.isSafeInteger(n);
const isFiniteNumber = (n: number) => Number.isFinite(n);

/** The `inject-vhal-event` data argument for a value, in the form the property's type parses. */
export function encodeVehiclePropertyValue(
  target: VehiclePropertyTarget,
  value: VehiclePropertyValue,
): string {
  switch (target.type) {
    case "BOOLEAN":
      return encodeBoolean(target, value);
    case "INT32":
    case "INT32_VEC":
      return encodeNumbers(target, value, {
        vector: target.type === "INT32_VEC",
        check: isInt32,
        expected: "a 32-bit integer",
      });
    case "INT64":
    case "INT64_VEC":
      return encodeNumbers(target, value, {
        vector: target.type === "INT64_VEC",
        check: isSafeInteger,
        expected: "an integer",
      });
    case "FLOAT":
    case "FLOAT_VEC":
      return encodeNumbers(target, value, {
        vector: target.type === "FLOAT_VEC",
        check: isFiniteNumber,
        expected: "a number",
      });
    default:
      throw new ActionableError(
        `${vehiclePropertyLabel(target)} is a ${target.type} property; \`cmd car_service inject-vhal-event\` only injects BOOLEAN, INT32, INT64 and FLOAT values and their vectors.`,
      );
  }
}

/** Which `RawPropValues` array carries each type's value. */
function valueField(type: string): string | undefined {
  if (type === "BOOLEAN" || type.startsWith("INT32")) {
    return "int32Values";
  }
  if (type.startsWith("INT64")) {
    return "int64Values";
  }
  return type.startsWith("FLOAT") ? "floatValues" : undefined;
}

/**
 * The value a `get-property-value <id> <areaId>` reply carries, in the encoding
 * {@link encodeVehiclePropertyValue} writes (`true`/`false` for BOOLEAN, comma-separated vectors),
 * or undefined when the reply has none. The reply prints the VHAL's `VehiclePropValue`, whose
 * `RawPropValues` lists `int32Values: [..]`, `floatValues: [..]` and `int64Values: [..]`.
 */
export function parseVehiclePropertyReadback(
  target: VehiclePropertyTarget,
  output: string,
): string | undefined {
  const field = valueField(target.type);
  if (field === undefined) {
    return undefined;
  }
  const list = new RegExp(`\\b${field}\\s*[:=]\\s*\\[([^\\]]*)\\]`).exec(output)?.[1];
  const values = list
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!values || values.length === 0 || !values.every((item) => Number.isFinite(Number(item)))) {
    return undefined;
  }
  if (target.type === "BOOLEAN") {
    return String(Number(values[0]) !== 0);
  }
  return values.join(",");
}

/** Whether two encoded values are the same value: numerically per element, booleans by text. */
export function sameVehiclePropertyValue(a: string, b: string): boolean {
  const left = a.split(",");
  const right = b.split(",");
  return (
    left.length === right.length &&
    left.every((item, i) => item === right[i] || Number(item) === Number(right[i]))
  );
}
