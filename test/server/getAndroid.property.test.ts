import { describe, test } from "bun:test";
import fc from "fast-check";
import { ActionableError, BootedDevice, DeviceInfo, Platform } from "../../src/models";
import {
  getAndroidSchema,
  isMismatchedBootedDeviceId,
  StartDeviceArgs,
  validateRequestedAndroidSerial,
} from "../../src/server/deviceTools";
import {
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../../src/utils/deviceTimeouts";
import {
  DEFAULT_RUNNER_PROVISION_TIMEOUT_MS,
  MIN_RUNNER_READINESS_TIMEOUT_MS,
} from "../../src/utils/runnerReadinessConfig";

// Property-based tests. See test/utils/Backoff.property.test.ts for the
// pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// A pool of identifiers small enough that names, serials, and requested ids
// collide often, so both the match and the mismatch branches are exercised.
const IDENTIFIERS = [
  "emulator-5554",
  "emulator-5556",
  "Pixel_A",
  "Pixel_B",
  "Nexus_9",
  "",
] as const;
const identifier = fc.constantFrom<string>(...IDENTIFIERS);
const nonEmptyIdentifier = fc.constantFrom<string>(
  ...IDENTIFIERS.filter((value) => value.length > 0),
);
const platform = fc.constantFrom<Platform>("android", "ios");

// ---------------------------------------------------------------------------
// getAndroidSchema — the tool call's input contract. It composes both
// underlying refinements: the avdName/deviceId presence rule and the
// boot+automation timeout-budget rule (validateDevicePreparationTimeout).
// ---------------------------------------------------------------------------
describe("getAndroidSchema (property-based)", () => {
  // Mixes boundary constants (positivity, per-field min/max, the shared budget
  // ceiling) with a broad range so the oracle sees both accept and reject.
  const timeoutValue = fc.oneof(
    fc.integer({ min: -5, max: 1_000_000 }),
    fc.constantFrom(
      0,
      1,
      MIN_RUNNER_READINESS_TIMEOUT_MS - 1,
      MIN_RUNNER_READINESS_TIMEOUT_MS,
      MAX_DEVICE_READY_TIMEOUT_MS,
      MAX_DEVICE_READY_TIMEOUT_MS + 1,
      MAX_DEVICE_READY_TIMEOUT_MS - DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ),
  );
  const timeoutField = fc.option(timeoutValue, { nil: undefined });
  const idField = fc.option(identifier, { nil: undefined });

  const inputArb = fc.record({
    avdName: idField,
    deviceId: idField,
    bootTimeoutMs: timeoutField,
    automationReadyTimeoutMs: timeoutField,
  });

  type SchemaInput = {
    avdName?: string;
    deviceId?: string;
    bootTimeoutMs?: number;
    automationReadyTimeoutMs?: number;
  };

  // Independent oracle for whether the schema should accept the input, derived
  // from the field constraints and the two superRefine rules — never from the
  // schema itself.
  const shouldParse = (input: SchemaInput): boolean => {
    // avdName/deviceId carry `.min(1)`: a present-but-empty string is rejected.
    if (input.avdName !== undefined && input.avdName.length < 1) {
      return false;
    }
    if (input.deviceId !== undefined && input.deviceId.length < 1) {
      return false;
    }
    // At least one identifier must be provided.
    if (input.avdName === undefined && input.deviceId === undefined) {
      return false;
    }
    // bootTimeoutMs: positive integer, at most the ceiling.
    if (input.bootTimeoutMs !== undefined) {
      if (!Number.isInteger(input.bootTimeoutMs)) {
        return false;
      }
      if (input.bootTimeoutMs <= 0 || input.bootTimeoutMs > MAX_DEVICE_READY_TIMEOUT_MS) {
        return false;
      }
    }
    // automationReadyTimeoutMs: integer within [MIN, MAX].
    if (input.automationReadyTimeoutMs !== undefined) {
      if (!Number.isInteger(input.automationReadyTimeoutMs)) {
        return false;
      }
      if (
        input.automationReadyTimeoutMs < MIN_RUNNER_READINESS_TIMEOUT_MS ||
        input.automationReadyTimeoutMs > MAX_DEVICE_READY_TIMEOUT_MS
      ) {
        return false;
      }
    }
    // Shared budget: the two windows, with defaults for omitted fields, must fit
    // under the single ceiling.
    const total =
      (input.bootTimeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS) +
      (input.automationReadyTimeoutMs ?? DEFAULT_RUNNER_PROVISION_TIMEOUT_MS);
    return total <= MAX_DEVICE_READY_TIMEOUT_MS;
  };

  test("accepts an input exactly when the field and budget rules all hold", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        return getAndroidSchema.safeParse(input).success === shouldParse(input);
      }),
      RUN_OPTIONS,
    );
  });

  test("rejects when neither avdName nor deviceId is present, for any valid budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: MIN_RUNNER_READINESS_TIMEOUT_MS, max: 100_000 }),
        (bootTimeoutMs, automationReadyTimeoutMs) => {
          return !getAndroidSchema.safeParse({ bootTimeoutMs, automationReadyTimeoutMs }).success;
        },
      ),
      RUN_OPTIONS,
    );
  });

  // avdName + deviceId together names ONE device; the schema deliberately does
  // not reject the pair (an identifier conflict is only detectable after
  // discovery — see validateRequestedAndroidSerial). Both values survive parse.
  test("accepts avdName and deviceId together and preserves both", () => {
    fc.assert(
      fc.property(nonEmptyIdentifier, nonEmptyIdentifier, (avdName, deviceId) => {
        const result = getAndroidSchema.safeParse({ avdName, deviceId });
        return (
          result.success && result.data.avdName === avdName && result.data.deviceId === deviceId
        );
      }),
      RUN_OPTIONS,
    );
  });

  // The base object is `.strict()` and `.extend()` preserves that, so any key
  // outside the schema fails the parse regardless of an otherwise-valid body.
  test("rejects any unknown key (strict object)", () => {
    const reserved = new Set(["avdName", "deviceId", "bootTimeoutMs", "automationReadyTimeoutMs"]);
    fc.assert(
      fc.property(
        nonEmptyIdentifier,
        fc.string({ minLength: 1, maxLength: 12 }).filter((key) => !reserved.has(key)),
        fc.anything(),
        (avdName, extraKey, extraValue) => {
          const result = getAndroidSchema.safeParse({ avdName, [extraKey]: extraValue });
          return !result.success;
        },
      ),
      RUN_OPTIONS,
    );
  });

  // Both timeout fields are `.int()`; a non-integer inside the valid numeric
  // range is still rejected.
  test("rejects a non-integer timeout even when it is within range", () => {
    fc.assert(
      fc.property(
        nonEmptyIdentifier,
        fc
          .double({ min: 1, max: 10_000, noNaN: true, noDefaultInfinity: true })
          .filter((value) => !Number.isInteger(value)),
        (avdName, bootTimeoutMs) => {
          return !getAndroidSchema.safeParse({ avdName, bootTimeoutMs }).success;
        },
      ),
      RUN_OPTIONS,
    );
  });
});

// ---------------------------------------------------------------------------
// validateRequestedAndroidSerial — reconciles a caller-supplied
// { avdName, deviceId } pair against the device actually resolved. `deviceId`
// is a serial OR an image name, so the pair names one device whenever the
// resolved serial, the resolved AVD name, or the source image name equals the
// requested deviceId. Anything else is an `identifier_conflict`.
// ---------------------------------------------------------------------------
describe("validateRequestedAndroidSerial (property-based)", () => {
  const bootedDevice = fc.record({
    name: identifier,
    platform,
    deviceId: identifier,
  }) as fc.Arbitrary<BootedDevice>;

  const sourceImage = fc.option(
    fc.record({
      name: identifier,
      platform,
      isRunning: fc.boolean(),
    }) as fc.Arbitrary<DeviceInfo>,
    { nil: undefined },
  );

  const pair = fc.option(fc.record({ avdName: nonEmptyIdentifier, deviceId: identifier }), {
    nil: undefined,
  });

  const matches = (
    p: { avdName: string; deviceId: string } | undefined,
    device: BootedDevice,
    image: DeviceInfo | undefined,
  ): boolean => {
    if (!p) {
      return true;
    }
    return (
      device.deviceId === p.deviceId || device.name === p.deviceId || image?.name === p.deviceId
    );
  };

  test("throws exactly when the pair matches no resolved identity", () => {
    fc.assert(
      fc.property(pair, bootedDevice, sourceImage, (p, device, image) => {
        let threw = false;
        try {
          validateRequestedAndroidSerial(p, device, image);
        } catch (error) {
          threw = true;
          if (!(error instanceof ActionableError)) {
            return false;
          }
        }
        return threw === !matches(p, device, image);
      }),
      RUN_OPTIONS,
    );
  });

  test("an undefined pair never throws", () => {
    fc.assert(
      fc.property(bootedDevice, sourceImage, (device, image) => {
        validateRequestedAndroidSerial(undefined, device, image);
        return true;
      }),
      RUN_OPTIONS,
    );
  });

  // A rejection must name both the requested deviceId and the avdName it came
  // with, so the caller can tell which two identifiers disagreed.
  test("the conflict error names both requested identifiers", () => {
    fc.assert(
      fc.property(pair, bootedDevice, sourceImage, (p, device, image) => {
        if (matches(p, device, image)) {
          return true; // no throw expected
        }
        try {
          validateRequestedAndroidSerial(p, device, image);
          return false; // must have thrown
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return (
            message.includes("identifier_conflict") &&
            message.includes(p!.avdName) &&
            message.includes(p!.deviceId)
          );
        }
      }),
      RUN_OPTIONS,
    );
  });
});

// ---------------------------------------------------------------------------
// isMismatchedBootedDeviceId — decides whether a booted device resolved for a
// `deviceId` request is a different device than the caller named. On Android
// `deviceId` doubles as an AVD image name, so a differing serial is still a
// match when the AVD name (on the device or its source image) matches.
// ---------------------------------------------------------------------------
describe("isMismatchedBootedDeviceId (property-based)", () => {
  const argsFor = (deviceId: string | undefined, devicePlatform: Platform): StartDeviceArgs => ({
    platform: devicePlatform,
    deviceId,
  });
  const bootedDevice = (
    name: string,
    devicePlatform: Platform,
    deviceId: string,
  ): BootedDevice => ({
    name,
    platform: devicePlatform,
    deviceId,
  });
  const imageWithName = (name: string, devicePlatform: Platform): DeviceInfo => ({
    name,
    platform: devicePlatform,
    isRunning: false,
  });

  test("returns a boolean and never throws for any input", () => {
    const anyId = fc.option(identifier, { nil: undefined });
    fc.assert(
      fc.property(
        anyId,
        platform,
        identifier,
        platform,
        identifier,
        fc.option(fc.record({ name: identifier }), { nil: undefined }),
        (requestedId, argPlatform, deviceName, devicePlatform, deviceSerial, image) => {
          const result = isMismatchedBootedDeviceId(
            argsFor(requestedId, argPlatform),
            bootedDevice(deviceName, devicePlatform, deviceSerial),
            image ? imageWithName(image.name, devicePlatform) : undefined,
          );
          return typeof result === "boolean";
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("no requested deviceId is never a mismatch", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<string | undefined>(undefined, ""),
        platform,
        identifier,
        platform,
        identifier,
        (requestedId, argPlatform, deviceName, devicePlatform, deviceSerial) => {
          return (
            isMismatchedBootedDeviceId(
              argsFor(requestedId, argPlatform),
              bootedDevice(deviceName, devicePlatform, deviceSerial),
              undefined,
            ) === false
          );
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("an exact serial match is never a mismatch, on any platform", () => {
    fc.assert(
      fc.property(
        nonEmptyIdentifier,
        platform,
        identifier,
        (serial, devicePlatform, deviceName) => {
          return (
            isMismatchedBootedDeviceId(
              argsFor(serial, devicePlatform),
              bootedDevice(deviceName, devicePlatform, serial),
              undefined,
            ) === false
          );
        },
      ),
      RUN_OPTIONS,
    );
  });

  // Android's deviceId-as-AVD-name allowance: a serial that differs is still a
  // match when the requested id names the AVD, on the device or its image.
  test("an Android AVD-name match (device or source image) is never a mismatch", () => {
    fc.assert(
      fc.property(
        nonEmptyIdentifier,
        nonEmptyIdentifier,
        fc.boolean(),
        (requestedId, otherSerial, nameOnDevice) => {
          // Guarantee the serial differs so only the name path can rescue it.
          const serial = `${otherSerial}#${requestedId}#serial`;
          const device = nameOnDevice
            ? bootedDevice(requestedId, "android", serial)
            : bootedDevice("some-other-name", "android", serial);
          const image = nameOnDevice ? undefined : imageWithName(requestedId, "android");
          return (
            isMismatchedBootedDeviceId(argsFor(requestedId, "android"), device, image) === false
          );
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("a requested id matching neither serial nor Android name is a mismatch", () => {
    fc.assert(
      fc.property(nonEmptyIdentifier, platform, (requestedId, devicePlatform) => {
        // Disjoint serial and names so nothing can match the requested id.
        const serial = `serial::${requestedId}`;
        const deviceName = `name::${requestedId}`;
        const imageName = `image::${requestedId}`;
        return (
          isMismatchedBootedDeviceId(
            argsFor(requestedId, devicePlatform),
            bootedDevice(deviceName, devicePlatform, serial),
            imageWithName(imageName, devicePlatform),
          ) === true
        );
      }),
      RUN_OPTIONS,
    );
  });
});
