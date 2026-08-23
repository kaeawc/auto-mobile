import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { PlanPartitioner } from "../../../src/utils/plan/PlanPartitioner";
import type { Plan, PlanStep } from "../../../src/models/Plan";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Short alphanumeric charset kept disjoint from the UNKNOWN_DEVICE sentinel below
// (that one is uppercase-only) so a generated label can never collide with it.
const deviceLabelChar = fc.constantFrom("a", "b", "c", "d", "1", "2");
const deviceLabel = fc.string({ unit: deviceLabelChar, minLength: 1, maxLength: 3 });
const deviceLabels = fc.uniqueArray(deviceLabel, { minLength: 2, maxLength: 4 });

const toolName = fc.string({
  unit: fc.constantFrom("a", "o", "L", "n", "k", "1", "T", "p"),
  maxLength: 16,
});

const UNKNOWN_DEVICE = "ZZ";

// Devices + steps generated together so every step's params.device is drawn
// from that same run's device labels (never a dangling reference).
const planArb = deviceLabels.chain((labels) =>
  fc
    .array(
      fc.record({
        tool: toolName,
        params: fc.record({ device: fc.constantFrom(...labels) }),
      }),
      { minLength: 0, maxLength: 30 },
    )
    .map((steps) => ({ labels, steps: steps as PlanStep[] })),
);

// Steps with no params.device at all — used only for the null-return cases,
// to avoid tripping partition()'s "missing device parameter" throw path.
const deviceFreeSteps = fc.array(fc.record({ tool: toolName, params: fc.constant({}) }), {
  maxLength: 30,
});

describe("PlanPartitioner.partition (property-based)", () => {
  test("invariant preservation: timeline has exactly one entry per step", () => {
    fc.assert(
      fc.property(planArb, ({ labels, steps }) => {
        const plan: Plan = { name: "p", devices: labels, steps };
        const result = PlanPartitioner.partition(plan)!;
        return result.timeline.length === steps.length;
      }),
      RUN_OPTIONS,
    );
  });

  test("partition invariant: every step lands in exactly one device track", () => {
    fc.assert(
      fc.property(planArb, ({ labels, steps }) => {
        const plan: Plan = { name: "p", devices: labels, steps };
        const result = PlanPartitioner.partition(plan)!;

        let totalTracked = 0;
        for (const track of result.deviceTracks.values()) {
          totalTracked += track.length;
        }

        const everyStepInItsTrack = steps.every((step) => {
          const track = result.deviceTracks.get(step.params.device);
          return track !== undefined && track.some((tracked) => tracked.step === step);
        });

        return totalTracked === steps.length && everyStepInItsTrack;
      }),
      RUN_OPTIONS,
    );
  });

  test("order preservation: each device track keeps original relative order", () => {
    fc.assert(
      fc.property(planArb, ({ labels, steps }) => {
        const plan: Plan = { name: "p", devices: labels, steps };
        const result = PlanPartitioner.partition(plan)!;

        return labels.every((label) => {
          const track = result.deviceTracks.get(label) ?? [];
          return track.every((entry, i) => {
            if (entry.trackIndex !== i) {
              return false;
            }
            return i === 0 || entry.planIndex > track[i - 1].planIndex;
          });
        });
      }),
      RUN_OPTIONS,
    );
  });

  test("returns null when devices is undefined or empty", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant([])),
        deviceFreeSteps,
        (devices, steps) => {
          const plan: Plan = { name: "p", devices, steps };
          return PlanPartitioner.partition(plan) === null;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("throws on a step referencing an undeclared device", () => {
    fc.assert(
      fc.property(
        deviceLabels,
        fc.array(toolName, { minLength: 1, maxLength: 10 }),
        fc.nat(),
        (labels, tools, seedIndex) => {
          const badIndex = seedIndex % tools.length;
          const steps: PlanStep[] = tools.map((tool, i) => ({
            tool,
            params: { device: i === badIndex ? UNKNOWN_DEVICE : labels[i % labels.length] },
          }));
          const plan: Plan = { name: "p", devices: labels, steps };

          expect(() => PlanPartitioner.partition(plan)).toThrow();
          return true;
        },
      ),
      RUN_OPTIONS,
    );
  });
});
