import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  provisionDeviceDeadlineMs,
  provisionDeviceFingerprint,
  type ProvisionDeviceArgs,
} from "../../src/server/deviceTools";
import {
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
} from "../../src/utils/deviceTimeouts";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed
// rationale: a fixed seed keeps CI deterministic while fast-check still prints
// the seed and shrunk counterexample on failure.
const RUN_OPTIONS = { seed: 0x50_72_6f_76, numRuns: 300 } as const;

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
