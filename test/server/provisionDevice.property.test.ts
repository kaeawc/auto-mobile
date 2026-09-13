import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { toJSONSchema } from "zod/v4";
import {
  provisionDeviceDeadlineMs,
  provisionDeviceFingerprint,
  provisionDeviceSchema,
  type ProvisionDeviceArgs,
} from "../../src/server/deviceTools";
import {
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
} from "../../src/utils/deviceTimeouts";
import { applyJsonSchemaOverride } from "../../src/server/toolSchemaHelpers";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed
// rationale: a fixed seed keeps CI deterministic while fast-check still prints
// the seed and shrunk counterexample on failure.
// numRuns is kept modest so each test clears the repo's 100ms unit-test budget
// (scripts/validate-bun-test-timings.sh) even on a slow CI runner: the sha256
// digest work in the "ignores operationId" case is the ceiling here.
const RUN_OPTIONS = { seed: 0x50_72_6f_76, numRuns: 150 } as const;

const shortString = fc.string({ maxLength: 24 });
const displayCutout = fc.constantFrom<ProvisionDeviceArgs["device"]["spec"]["displayCutout"]>(
  undefined,
  "none",
  "notch",
  "dynamic_island",
  "hole_punch",
  "any",
);
const resources = fc.constantFrom<ProvisionDeviceArgs["resources"]>(
  undefined,
  { wallpaperRendering: "disabled" },
  { wallpaperRendering: "enabled" },
  { widgets: "disabled" },
);
// The transport-injected params and operationId are deliberately EXCLUDED from
// the fingerprint (it must identify the request, not which caller or attempt
// sent it), so the arbitrary varies them to prove they never leak in.
const internalNoise = fc.record({
  operationId: shortString,
  __mcpSessionId: fc.option(shortString, { nil: undefined }),
  __mcpRequestTimeoutMs: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
  __mcpRequestDeadlineMs: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
});

const provisionArgs: fc.Arbitrary<ProvisionDeviceArgs> = fc
  .record({
    operationId: shortString,
    platform: fc.constantFrom("android" as const, "ios" as const),
    name: shortString,
    runtime: shortString,
    deviceType: shortString,
    memoryMb: fc.option(fc.integer({ min: 2048, max: 8192 }), { nil: undefined }),
    displayCutout,
    boot: fc.boolean(),
    readiness: fc.constantFrom("automation" as const, "none" as const),
    timeoutMs: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
    resources,
  })
  .map((parts) => ({
    operationId: parts.operationId,
    device: {
      platform: parts.platform,
      name: parts.name,
      spec: {
        runtime: parts.runtime,
        deviceType: parts.deviceType,
        ...(parts.displayCutout ? { displayCutout: parts.displayCutout } : {}),
        ...(parts.platform === "android" && parts.memoryMb !== undefined
          ? { configuration: { memoryMb: parts.memoryMb } }
          : {}),
      },
    },
    boot: parts.boot,
    readiness: parts.readiness,
    ...(parts.resources ? { resources: parts.resources } : {}),
    ...(parts.timeoutMs !== undefined ? { timeoutMs: parts.timeoutMs } : {}),
  }));

describe("provisionDeviceFingerprint (property-based)", () => {
  test("is deterministic and a 64-char lowercase hex digest", () => {
    fc.assert(
      fc.property(provisionArgs, (args) => {
        const first = provisionDeviceFingerprint(args);
        const second = provisionDeviceFingerprint({ ...args });
        expect(first).toBe(second);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
      }),
      RUN_OPTIONS,
    );
  });

  test("ignores operationId and transport-injected params", () => {
    fc.assert(
      fc.property(provisionArgs, internalNoise, internalNoise, (args, noiseA, noiseB) => {
        // Two callers reusing the same request under different operationIds /
        // transport budgets must fingerprint identically, or a legitimate replay
        // would be rejected as a conflicting reuse of the operationId.
        return (
          provisionDeviceFingerprint({ ...args, ...noiseA }) ===
          provisionDeviceFingerprint({ ...args, ...noiseB })
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("treats an undefined optional field as an omitted one", () => {
    fc.assert(
      fc.property(provisionArgs, (args) => {
        const withUndefined: ProvisionDeviceArgs = {
          ...args,
          resources: args.resources,
          timeoutMs: args.timeoutMs,
        };
        // stableStringify drops undefined-valued keys, so an explicit
        // `resources: undefined` / `timeoutMs: undefined` cannot fingerprint
        // differently from omitting the key.
        return provisionDeviceFingerprint(args) === provisionDeviceFingerprint(withUndefined);
      }),
      RUN_OPTIONS,
    );
  });

  test("changing any fingerprinted field changes the digest", () => {
    fc.assert(
      fc.property(
        provisionArgs,
        fc.constantFrom("boot", "readiness", "name", "timeoutMs", "resources"),
        (args, field) => {
          const base = provisionDeviceFingerprint(args);
          let mutated: ProvisionDeviceArgs;
          switch (field) {
            case "boot":
              mutated = { ...args, boot: !args.boot };
              break;
            case "readiness":
              mutated = {
                ...args,
                readiness: args.readiness === "automation" ? "none" : "automation",
              };
              break;
            case "name":
              mutated = { ...args, device: { ...args.device, name: `${args.device.name}-x` } };
              break;
            case "timeoutMs":
              mutated = { ...args, timeoutMs: (args.timeoutMs ?? 0) + 1 };
              break;
            default:
              mutated = args.resources
                ? { ...args, resources: undefined }
                : { ...args, resources: { wallpaperRendering: "disabled" } };
          }
          return provisionDeviceFingerprint(mutated) !== base;
        },
      ),
      RUN_OPTIONS,
    );
  });
});

const RESERVED_ROLLBACK_MS =
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;

const deadlineInputs = fc.record({
  now: fc.integer({ min: 0, max: 10_000_000 }),
  timeoutMs: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
  mcpDeadlineMs: fc.option(fc.integer({ min: 0, max: 20_000_000 }), { nil: undefined }),
});

function argsFor(timeoutMs: number | undefined, mcpDeadlineMs: number | undefined) {
  return {
    operationId: "op",
    device: { platform: "android", name: "d", spec: { runtime: "r", deviceType: "t" } },
    boot: true,
    readiness: "automation",
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(mcpDeadlineMs !== undefined ? { __mcpRequestDeadlineMs: mcpDeadlineMs } : {}),
  } as ProvisionDeviceArgs;
}

describe("provisionDeviceDeadlineMs (property-based)", () => {
  test("without reservation the deadline is exactly the requested budget", () => {
    fc.assert(
      fc.property(deadlineInputs, ({ now, timeoutMs, mcpDeadlineMs }) => {
        const args = argsFor(timeoutMs, mcpDeadlineMs);
        const requested = now + (timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
        return provisionDeviceDeadlineMs(args, { now: () => now }, false) === requested;
      }),
      RUN_OPTIONS,
    );
  });

  test("with no transport deadline, reservation cannot shorten the budget", () => {
    fc.assert(
      fc.property(deadlineInputs, ({ now, timeoutMs }) => {
        const args = argsFor(timeoutMs, undefined);
        const requested = now + (timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
        return provisionDeviceDeadlineMs(args, { now: () => now }, true) === requested;
      }),
      RUN_OPTIONS,
    );
  });

  test("reserving never yields a later deadline than the requested budget", () => {
    fc.assert(
      fc.property(deadlineInputs, ({ now, timeoutMs, mcpDeadlineMs }) => {
        const args = argsFor(timeoutMs, mcpDeadlineMs);
        const timer = { now: () => now };
        const requested = now + (timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
        const reserved = provisionDeviceDeadlineMs(args, timer, true);
        const unreserved = provisionDeviceDeadlineMs(args, timer, false);
        return reserved <= requested && reserved <= unreserved;
      }),
      RUN_OPTIONS,
    );
  });

  test("with a transport deadline, reservation clamps to the min of budget and reserved window", () => {
    fc.assert(
      fc.property(
        fc.record({
          now: fc.integer({ min: 0, max: 10_000_000 }),
          timeoutMs: fc.integer({ min: 1, max: 1_000_000 }),
          mcpDeadlineMs: fc.integer({ min: 0, max: 20_000_000 }),
        }),
        ({ now, timeoutMs, mcpDeadlineMs }) => {
          const args = argsFor(timeoutMs, mcpDeadlineMs);
          const requested = now + timeoutMs;
          const expected = Math.min(requested, mcpDeadlineMs - RESERVED_ROLLBACK_MS);
          const result = provisionDeviceDeadlineMs(args, { now: () => now }, true);
          return result === expected && result <= mcpDeadlineMs - RESERVED_ROLLBACK_MS;
        },
      ),
      RUN_OPTIONS,
    );
  });
});

// #6869 — provisionDevice mints a session, so it declares capabilities at
// acquisition with the same `enableTools` field getAndroid/getApple carry.
describe("provisionDeviceSchema enableTools (property-based)", () => {
  const base = {
    operationId: "op-1",
    device: {
      platform: "android" as const,
      name: "Pixel_A",
      spec: { runtime: "system-images;android-35;google_apis;x86_64", deviceType: "pixel_6" },
    },
  };

  test("accepts a non-empty array of non-empty names and rejects anything else", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 8 }), { minLength: 0, maxLength: 4 }),
        (enableTools) => {
          const expected = enableTools.length > 0 && enableTools.every((n) => n.length > 0);
          return provisionDeviceSchema.safeParse({ ...base, enableTools }).success === expected;
        },
      ),
      RUN_OPTIONS,
    );
  });

  // `enableTools` declares SESSION capabilities, not device identity, so it must
  // not change the idempotency fingerprint — two otherwise-identical calls that
  // ask for different capabilities still name the same provisioned device.
  test("does not enter the idempotency fingerprint", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 }),
        (enableTools) => {
          const args = provisionDeviceSchema.parse({ ...base, enableTools }) as ProvisionDeviceArgs;
          const without = provisionDeviceSchema.parse(base) as ProvisionDeviceArgs;
          return provisionDeviceFingerprint(args) === provisionDeviceFingerprint(without);
        },
      ),
      RUN_OPTIONS,
    );
  });

  // A `boot: false` provision never mints a session, so there is nothing to
  // grant the declared capabilities against and the request would be accepted
  // and silently discarded. Reject it at the schema, exactly like `resources`
  // (#6886 review).
  test("rejects a capability declaration that cannot be granted (boot=false)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 }),
        fc.constantFrom<boolean | undefined>(undefined, true, false),
        (enableTools, boot) => {
          const args = { ...base, enableTools, ...(boot === undefined ? {} : { boot }) };
          return provisionDeviceSchema.safeParse(args).success === (boot !== false);
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("still accepts boot=false when no capability is declared", () => {
    expect(provisionDeviceSchema.safeParse({ ...base, boot: false }).success).toBe(true);
  });

  test("advertises the boot requirement for both enableTools and resources", () => {
    const schema = toJSONSchema(provisionDeviceSchema, {
      io: "input",
      override: ({ zodSchema, jsonSchema }) => applyJsonSchemaOverride(zodSchema, jsonSchema),
    }) as Record<string, unknown>;

    expect(schema.if).toEqual({
      anyOf: [{ required: ["resources"] }, { required: ["enableTools"] }],
    });
    expect(schema.then).toEqual({ properties: { boot: { const: true } } });
    // A top-level combinator is not publishable (#5870), so the conditional
    // keeps its `anyOf` nested inside `if`.
    expect(schema.allOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
  });

  test("stays strict about every other unknown key", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter(
            (key) =>
              ![
                "operationId",
                "device",
                "resources",
                "boot",
                "readiness",
                "timeoutMs",
                "enableTools",
              ].includes(key),
          ),
        (key) => !provisionDeviceSchema.safeParse({ ...base, [key]: "value" }).success,
      ),
      RUN_OPTIONS,
    );
  });
});
