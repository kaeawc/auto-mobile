import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  isIosPhysicalUdid,
  isIosSimulatorUdid,
  isIosUdid,
} from "../../../src/utils/ios-cmdline-tools/iosDeviceType";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const hex = (n: number): fc.Arbitrary<string> =>
  fc
    .array(fc.integer({ min: 0, max: 15 }), { minLength: n, maxLength: n })
    .map((a) => a.map((x) => x.toString(16)).join(""));

const simUuid = fc.tuple(hex(8), hex(4), hex(4), hex(4), hex(12)).map((g) => g.join("-"));
const physModern = fc.tuple(hex(8), hex(16)).map((g) => g.join("-"));
const physLegacy = hex(40);
// Android device ids that must NEVER be classified as iOS (issue #4165):
// CDD Build.SERIAL grammar (alphanumeric, <= 20), plus the other adb id shapes.
const androidSerial = fc.string({
  unit: fc.constantFrom("a", "Z", "0", "9", "x", "7"),
  maxLength: 20,
});
const adbShape = fc.oneof(
  fc.integer({ min: 5554, max: 5680 }).map((p) => `emulator-${p}`),
  fc
    .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 1024, max: 65535 }))
    .map(([h, p]) => `192.168.1.${h}:${p}`),
  fc.constant("adb-ABC123-XYZ456._adb-tls-connect._tcp"),
);

describe("iosDeviceType (property-based)", () => {
  test("a simulator UUID is a simulator, not physical, and is iOS (any casing)", () => {
    fc.assert(
      fc.property(simUuid, fc.boolean(), (id, upper) => {
        const u = upper ? id.toUpperCase() : id;
        return isIosSimulatorUdid(u) && !isIosPhysicalUdid(u) && isIosUdid(u);
      }),
      RUN_OPTIONS,
    );
  });

  test("a physical UDID (modern or legacy) is physical, not a simulator, and is iOS", () => {
    fc.assert(
      fc.property(fc.oneof(physModern, physLegacy), fc.boolean(), (id, upper) => {
        const u = upper ? id.toUpperCase() : id;
        return isIosPhysicalUdid(u) && !isIosSimulatorUdid(u) && isIosUdid(u);
      }),
      RUN_OPTIONS,
    );
  });

  test("simulator and physical classifications are mutually exclusive for any input", () => {
    fc.assert(
      fc.property(
        fc.oneof(simUuid, physModern, physLegacy, androidSerial, fc.string({ maxLength: 45 })),
        (id) => !(isIosSimulatorUdid(id) && isIosPhysicalUdid(id)),
      ),
      RUN_OPTIONS,
    );
  });

  test("isIosUdid is exactly the disjunction of the two specific predicates", () => {
    fc.assert(
      fc.property(
        fc.oneof(simUuid, physModern, physLegacy, fc.string({ maxLength: 45 })),
        (id) => isIosUdid(id) === (isIosSimulatorUdid(id) || isIosPhysicalUdid(id)),
      ),
      RUN_OPTIONS,
    );
  });

  test("Android serials and other adb id shapes are never classified as iOS (issue #4165)", () => {
    fc.assert(
      fc.property(
        fc.oneof(androidSerial, adbShape),
        (id) => !isIosSimulatorUdid(id) && !isIosPhysicalUdid(id) && !isIosUdid(id),
      ),
      RUN_OPTIONS,
    );
  });

  test("a non-hex character in a constrained position disqualifies a would-be UUID", () => {
    fc.assert(
      fc.property(simUuid, fc.integer({ min: 0, max: 35 }), (id, pos) => {
        // Replace one hex position (skip the 4 hyphen slots) with 'g'.
        const chars = [...id];
        const hexPositions = chars.map((c, i) => (c === "-" ? -1 : i)).filter((i) => i >= 0);
        chars[hexPositions[pos % hexPositions.length]] = "g";
        return !isIosSimulatorUdid(chars.join(""));
      }),
      RUN_OPTIONS,
    );
  });

  test("classification is case-insensitive", () => {
    fc.assert(
      fc.property(
        fc.oneof(simUuid, physModern, physLegacy),
        (id) =>
          isIosUdid(id) === isIosUdid(id.toUpperCase()) &&
          isIosUdid(id) === isIosUdid(id.toLowerCase()),
      ),
      RUN_OPTIONS,
    );
  });

  test("is total — a boolean for arbitrary strings, never throwing", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 50 }),
        (id) =>
          typeof isIosSimulatorUdid(id) === "boolean" &&
          typeof isIosPhysicalUdid(id) === "boolean" &&
          typeof isIosUdid(id) === "boolean",
      ),
      RUN_OPTIONS,
    );
  });
});
