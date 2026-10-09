import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { toJSONSchema } from "zod/v4";
import {
  provisionDeviceDeadlineMs,
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
// (scripts/validate-bun-test-timings.sh) even on a slow CI runner.
const RUN_OPTIONS = { seed: 0x50_72_6f_76, numRuns: 150 } as const;

const RESERVED_ROLLBACK_MS =
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;

const deadlineInputs = fc.record({
  now: fc.integer({ min: 0, max: 10_000_000 }),
  timeoutMs: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
  mcpDeadlineMs: fc.option(fc.integer({ min: 0, max: 20_000_000 }), { nil: undefined }),
});

function argsFor(timeoutMs: number | undefined, mcpDeadlineMs: number | undefined) {
  return {
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

  test("does not advertise the boot requirement as a schema conditional (runtime-enforced)", () => {
    // The boot requirement is enforced at runtime by the zod `.refine` (covered
    // by the safeParse property tests above). It is no longer emitted as an
    // `if`/`then` conditional: `enforceAnthropicToolSchemaSubset` strips
    // conditional/combinator keywords from the advertised wire schema (they are
    // rejected by the Anthropic input_schema subset, #7429), so the emitter that
    // used to add them was removed as dead.
    const schema = toJSONSchema(provisionDeviceSchema, {
      io: "input",
      override: ({ zodSchema, jsonSchema }) => applyJsonSchemaOverride(zodSchema, jsonSchema),
    }) as Record<string, unknown>;

    expect(schema.if).toBeUndefined();
    expect(schema.then).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
  });

  // #11065: provisionDevice no longer takes an idempotency key.
  test("rejects operationId", () => {
    expect(provisionDeviceSchema.safeParse({ ...base, operationId: "op-1" }).success).toBe(false);
  });

  test("stays strict about every other unknown key", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 12 })
          .filter(
            (key) =>
              !["device", "resources", "boot", "readiness", "timeoutMs", "enableTools"].includes(
                key,
              ),
          ),
        (key) => !provisionDeviceSchema.safeParse({ ...base, [key]: "value" }).success,
      ),
      RUN_OPTIONS,
    );
  });
});
