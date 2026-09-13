import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { getAndroidSchema, getAppleSchema } from "../../src/server/deviceTools";
import {
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../../src/utils/deviceTimeouts";
import { MIN_RUNNER_READINESS_TIMEOUT_MS } from "../../src/utils/runnerReadinessConfig";

// Property-based tests for the `getApple` tool's input contract. See
// test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// A small pool of identifiers so equal/different/absent combinations all recur
// densely — random unbounded strings would almost never collide, leaving the
// "udid === deviceId is accepted" branch untested.
const ID_POOL = ["udid-A", "udid-B", "SIM-0000-1111", "abc"] as const;
const optionalId = fc.option(fc.constantFrom(...ID_POOL), { nil: undefined });

const KNOWN_KEYS = ["udid", "deviceId", "bootTimeoutMs", "automationReadyTimeoutMs"];

// Timeout fields pass their own `.int().max(MAX)` (and `.min(MIN)` for the
// automation field) individually, so these generators isolate the cross-field
// `bootTimeoutMs + automationReadyTimeoutMs <= MAX` refinement.
const validBoot = fc.integer({ min: 1, max: MAX_DEVICE_READY_TIMEOUT_MS });
const validAuto = fc.integer({
  min: MIN_RUNNER_READINESS_TIMEOUT_MS,
  max: MAX_DEVICE_READY_TIMEOUT_MS,
});

/** Build an args object, omitting fields whose value is `undefined`. */
function args(
  udid?: string,
  deviceId?: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(udid !== undefined ? { udid } : {}),
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(extra ?? {}),
  };
}

describe("getAppleSchema identifier contract (property-based)", () => {
  // A caller must name a simulator, and when they name it twice the two
  // spellings must agree — otherwise the schema cannot know which device the
  // caller meant. No timeout fields are supplied, so the sum refine (defaults
  // 180s + 180s <= MAX) always passes and only the identifier logic is tested.
  test("succeeds iff at least one identifier is present and any two agree", () => {
    fc.assert(
      fc.property(optionalId, optionalId, (udid, deviceId) => {
        const result = getAppleSchema.safeParse(args(udid, deviceId));
        const bothMissing = udid === undefined && deviceId === undefined;
        const conflict = udid !== undefined && deviceId !== undefined && udid !== deviceId;
        return result.success === (!bothMissing && !conflict);
      }),
      RUN_OPTIONS,
    );
  });

  test("neither identifier present reports the 'Provide udid or deviceId' issue on `udid`", () => {
    const result = getAppleSchema.safeParse(args(undefined, undefined));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join(".") === "udid");
      expect(issue?.message).toContain("Provide udid or deviceId");
    }
  });

  test("two different identifiers report `identifier_conflict` on `deviceId`", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ID_POOL), fc.constantFrom(...ID_POOL), (udid, deviceId) => {
        fc.pre(udid !== deviceId);
        const result = getAppleSchema.safeParse(args(udid, deviceId));
        if (result.success) {
          return false;
        }
        const issue = result.error.issues.find((i) => i.path.join(".") === "deviceId");
        return (
          issue !== undefined &&
          issue.message.includes("identifier_conflict") &&
          issue.message.includes(udid) &&
          issue.message.includes(deviceId)
        );
      }),
      RUN_OPTIONS,
    );
  });

  // The handler resolves the effective UDID as `args.udid ?? args.deviceId`;
  // for every accepted input that resolution is a non-empty string equal to one
  // of the supplied identifiers (never a value the caller did not name).
  test("accepted inputs preserve the identifier the handler resolves", () => {
    fc.assert(
      fc.property(optionalId, optionalId, (udid, deviceId) => {
        const result = getAppleSchema.safeParse(args(udid, deviceId));
        if (!result.success) {
          return true;
        }
        const resolved = result.data.udid ?? result.data.deviceId;
        return (
          typeof resolved === "string" &&
          resolved.length > 0 &&
          (resolved === udid || resolved === deviceId)
        );
      }),
      RUN_OPTIONS,
    );
  });
});

describe("getAppleSchema timeout contract (property-based)", () => {
  test("succeeds iff bootTimeoutMs + automationReadyTimeoutMs <= MAX", () => {
    fc.assert(
      fc.property(validBoot, validAuto, (bootTimeoutMs, automationReadyTimeoutMs) => {
        const result = getAppleSchema.safeParse(
          args("sim", undefined, { bootTimeoutMs, automationReadyTimeoutMs }),
        );
        return (
          result.success === bootTimeoutMs + automationReadyTimeoutMs <= MAX_DEVICE_READY_TIMEOUT_MS
        );
      }),
      RUN_OPTIONS,
    );
  });

  // An omitted bootTimeoutMs still counts as its default in the sum, so the
  // ceiling on a lone automationReadyTimeoutMs is MAX - DEFAULT, not MAX.
  test("omitted bootTimeoutMs contributes its default to the sum", () => {
    fc.assert(
      fc.property(validAuto, (automationReadyTimeoutMs) => {
        const result = getAppleSchema.safeParse(
          args("sim", undefined, { automationReadyTimeoutMs }),
        );
        const withinBudget =
          DEFAULT_DEVICE_READY_TIMEOUT_MS + automationReadyTimeoutMs <= MAX_DEVICE_READY_TIMEOUT_MS;
        return result.success === withinBudget;
      }),
      RUN_OPTIONS,
    );
  });

  // Non-integer, zero, and negative timeouts fail the field-level guards before
  // the cross-field refine ever runs.
  test("rejects non-integer or non-positive bootTimeoutMs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: 0.1, max: 0.9, noNaN: true }),
          fc.integer({ min: -10_000, max: 0 }),
        ),
        (bootTimeoutMs) => {
          const result = getAppleSchema.safeParse(args("sim", undefined, { bootTimeoutMs }));
          return result.success === false;
        },
      ),
      RUN_OPTIONS,
    );
  });
});

describe("getAppleSchema strictness (property-based)", () => {
  test("rejects any unknown top-level key", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((k) => !KNOWN_KEYS.includes(k)),
        (key) => {
          const result = getAppleSchema.safeParse(args("sim", undefined, { [key]: "value" }));
          return result.success === false;
        },
      ),
      RUN_OPTIONS,
    );
  });
});

describe("getApple / getAndroid schema parity (property-based)", () => {
  // Both device-preparation tools share `devicePreparationTimeoutSchema`, so a
  // timeout pair accepted by one must be accepted by the other (each supplied
  // with its own required identifier).
  test("identical timeout pairs are accepted or rejected the same way by both schemas", () => {
    fc.assert(
      fc.property(validBoot, validAuto, (bootTimeoutMs, automationReadyTimeoutMs) => {
        const timeouts = { bootTimeoutMs, automationReadyTimeoutMs };
        const apple = getAppleSchema.safeParse({ udid: "sim", ...timeouts });
        const android = getAndroidSchema.safeParse({ avdName: "Pixel", ...timeouts });
        return apple.success === android.success;
      }),
      RUN_OPTIONS,
    );
  });
});
