import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  MIN_START_DEVICE_MCP_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
  resolveMcpRequestTimeoutMs,
} from "../../src/daemon/mcpRequestTimeout";
import type { DaemonRequest } from "../../src/daemon/types";
import {
  DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS,
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../../src/utils/deviceTimeouts";
import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "../../src/utils/runnerReadinessConfig";

// Property-based tests for the transport-timeout budget the daemon derives for a
// `getApple` request — the "underlying component" that keeps the socket alive
// for the full device-preparation window. See test/utils/Backoff.property.test.ts
// for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const DEFAULT_PREPARATION_BUDGET_MS =
  DEFAULT_DEVICE_READY_TIMEOUT_MS +
  DEFAULT_RUNNER_PROVISION_TIMEOUT_MS +
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;

function getAppleRequest(args: Record<string, unknown>, timeoutMs?: number): DaemonRequest {
  return {
    id: "prop",
    type: "mcp_request",
    method: "tools/call",
    params: { name: "getApple", arguments: args },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

// Independent re-derivation of the daemon's budget math, used as the oracle. A
// value only counts toward the boot/automation sum when it is a finite positive
// number; anything else falls back to the tool's default.
function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function expectedNamedBudget(args: Record<string, unknown>): number {
  const boot = positiveFinite(args.bootTimeoutMs) ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
  const auto = positiveFinite(args.automationReadyTimeoutMs) ?? DEFAULT_RUNNER_PROVISION_TIMEOUT_MS;
  return Math.min(boot + auto, MAX_DEVICE_READY_TIMEOUT_MS) + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;
}

function expectedResolved(args: Record<string, unknown>, timeoutMs?: number): number {
  const base =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  return Math.max(base, MIN_START_DEVICE_MCP_TIMEOUT_MS, expectedNamedBudget(args));
}

// Cover the realistic operating range plus the junk values the resolver must
// treat as "use the default": non-positive, non-finite, and absent.
const timeoutValue = fc.oneof(
  fc.integer({ min: 1, max: MAX_DEVICE_READY_TIMEOUT_MS }),
  fc.integer({ min: MAX_DEVICE_READY_TIMEOUT_MS, max: Number.MAX_SAFE_INTEGER }),
  fc.constantFrom(0, -1, -50_000, Number.NaN, Number.POSITIVE_INFINITY),
);
const optionalTimeout = fc.option(timeoutValue, { nil: undefined });
const preparationArgs = fc.record(
  { bootTimeoutMs: optionalTimeout, automationReadyTimeoutMs: optionalTimeout },
  { requiredKeys: [] },
);
const optionalRequestTimeout = fc.option(timeoutValue, { nil: undefined });

describe("getApple MCP request timeout budget (property-based)", () => {
  test("matches the independently derived budget for any argument shape", () => {
    fc.assert(
      fc.property(preparationArgs, optionalRequestTimeout, (args, requestTimeout) => {
        return (
          resolveMcpRequestTimeoutMs(getAppleRequest(args, requestTimeout)) ===
          expectedResolved(args, requestTimeout)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("is never below the getApple/startDevice floor", () => {
    fc.assert(
      fc.property(preparationArgs, optionalRequestTimeout, (args, requestTimeout) => {
        return (
          resolveMcpRequestTimeoutMs(getAppleRequest(args, requestTimeout)) >=
          MIN_START_DEVICE_MCP_TIMEOUT_MS
        );
      }),
      RUN_OPTIONS,
    );
  });

  // Without a client-supplied request timeout the whole budget is driven by the
  // preparation window, which is capped so the socket cannot idle out mid-boot.
  test("stays below the daemon socket idle timeout when the client omits timeoutMs", () => {
    fc.assert(
      fc.property(preparationArgs, (args) => {
        return (
          resolveMcpRequestTimeoutMs(getAppleRequest(args)) < DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS
        );
      }),
      RUN_OPTIONS,
    );
  });

  // Garbage boot/automation values (zero, negative, NaN, Infinity, absent) all
  // collapse to the same default preparation budget.
  test("junk or omitted timeouts collapse to the default preparation budget", () => {
    const junk = fc.constantFrom(undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY);
    fc.assert(
      fc.property(junk, junk, (boot, auto) => {
        const args: Record<string, unknown> = {
          ...(boot !== undefined ? { bootTimeoutMs: boot } : {}),
          ...(auto !== undefined ? { automationReadyTimeoutMs: auto } : {}),
        };
        return resolveMcpRequestTimeoutMs(getAppleRequest(args)) === DEFAULT_PREPARATION_BUDGET_MS;
      }),
      RUN_OPTIONS,
    );
  });

  // Enlarging either requested window (with no client timeoutMs to dominate the
  // max) can only hold or raise the budget, never lower it.
  test("is monotonic non-decreasing in the requested boot window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_DEVICE_READY_TIMEOUT_MS }),
        fc.integer({ min: 0, max: MAX_DEVICE_READY_TIMEOUT_MS }),
        fc.integer({ min: 1, max: MAX_DEVICE_READY_TIMEOUT_MS }),
        (boot, delta, auto) => {
          const smaller = resolveMcpRequestTimeoutMs(
            getAppleRequest({ bootTimeoutMs: boot, automationReadyTimeoutMs: auto }),
          );
          const larger = resolveMcpRequestTimeoutMs(
            getAppleRequest({ bootTimeoutMs: boot + delta, automationReadyTimeoutMs: auto }),
          );
          return larger >= smaller;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("saturates at the capped preparation budget for arbitrarily large windows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_DEVICE_READY_TIMEOUT_MS, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: MAX_DEVICE_READY_TIMEOUT_MS, max: Number.MAX_SAFE_INTEGER }),
        (boot, auto) => {
          const resolved = resolveMcpRequestTimeoutMs(
            getAppleRequest({ bootTimeoutMs: boot, automationReadyTimeoutMs: auto }),
          );
          return resolved === MAX_DEVICE_READY_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;
        },
      ),
      RUN_OPTIONS,
    );
  });

  // getApple and getAndroid share `resolveNamedDevicePreparationBudgetMs`, so
  // identical timeout arguments must yield identical transport budgets.
  test("resolves the same budget as getAndroid for identical arguments", () => {
    fc.assert(
      fc.property(preparationArgs, optionalRequestTimeout, (args, requestTimeout) => {
        const apple = resolveMcpRequestTimeoutMs(getAppleRequest(args, requestTimeout));
        const androidRequest: DaemonRequest = {
          id: "prop",
          type: "mcp_request",
          method: "tools/call",
          params: { name: "getAndroid", arguments: args },
          ...(requestTimeout !== undefined ? { timeoutMs: requestTimeout } : {}),
        };
        return apple === resolveMcpRequestTimeoutMs(androidRequest);
      }),
      RUN_OPTIONS,
    );
  });
});

// A concrete anchor alongside the properties: the documented default budget.
describe("getApple MCP request timeout budget (example)", () => {
  test("default preparation budget is 180s + 180s + overhead", () => {
    expect(resolveMcpRequestTimeoutMs(getAppleRequest({ udid: "sim" }))).toBe(
      DEFAULT_PREPARATION_BUDGET_MS,
    );
  });
});
