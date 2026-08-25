import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  DEFAULT_DEVICE_SNAPSHOT_CONFIG,
  parseDeviceSnapshotConfig,
} from "../../../src/features/snapshot";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Positive numeric inputs, deliberately including the (0, 0.5) zone that rounds
// to 0 for the integer (allowFloat:false) fields. Before the fix this zone was
// excluded because parsePositiveNumber checked positivity before rounding and
// returned 0; the check now runs after rounding, so the zone is back in scope
// and locks the regression.
const positiveNumber = fc.oneof(
  fc.double({ min: Number.EPSILON, max: 0.499_999, noNaN: true }),
  fc.double({ min: 0.5, max: 1e9, noNaN: true }),
  fc.integer({ min: 1, max: 1_000_000 }),
);

describe("parseDeviceSnapshotConfig (property-based)", () => {
  test("the (0, 0.5) rounding-to-zero repro no longer returns 0", () => {
    expect(parseDeviceSnapshotConfig({ vmSnapshotTimeoutMs: 0.3 }).vmSnapshotTimeoutMs).toBe(
      DEFAULT_DEVICE_SNAPSHOT_CONFIG.vmSnapshotTimeoutMs,
    );
  });

  test("integer timeout fields are always positive integers for positive input", () => {
    fc.assert(
      fc.property(positiveNumber, (vm) => {
        const config = parseDeviceSnapshotConfig({
          vmSnapshotTimeoutMs: vm,
        });
        return Number.isInteger(config.vmSnapshotTimeoutMs) && config.vmSnapshotTimeoutMs > 0;
      }),
      RUN_OPTIONS,
    );
  });

  test("maxArchiveSizeMb stays positive for positive input", () => {
    fc.assert(
      fc.property(positiveNumber, (size) => {
        return parseDeviceSnapshotConfig({ maxArchiveSizeMb: size }).maxArchiveSizeMb > 0;
      }),
      RUN_OPTIONS,
    );
  });

  test("parsing is idempotent: parse(parse(x)) === parse(x)", () => {
    fc.assert(
      fc.property(positiveNumber, positiveNumber, (vm, size) => {
        const once = parseDeviceSnapshotConfig({
          vmSnapshotTimeoutMs: vm,
          maxArchiveSizeMb: size,
        });
        const twice = parseDeviceSnapshotConfig(once);
        return (
          twice.vmSnapshotTimeoutMs === once.vmSnapshotTimeoutMs &&
          twice.maxArchiveSizeMb === once.maxArchiveSizeMb
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("non-positive and non-finite inputs fall back to defaults", () => {
    const nonPositive = fc.oneof(
      fc.double({ min: -1e9, max: 0, noNaN: true }),
      fc.constantFrom(NaN, Infinity, -Infinity),
    );
    fc.assert(
      fc.property(nonPositive, (value) => {
        const config = parseDeviceSnapshotConfig({
          vmSnapshotTimeoutMs: value,
          maxArchiveSizeMb: value,
        });
        return (
          config.vmSnapshotTimeoutMs === DEFAULT_DEVICE_SNAPSHOT_CONFIG.vmSnapshotTimeoutMs &&
          config.maxArchiveSizeMb === DEFAULT_DEVICE_SNAPSHOT_CONFIG.maxArchiveSizeMb
        );
      }),
      RUN_OPTIONS,
    );
  });
});
