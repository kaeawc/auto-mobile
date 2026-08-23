import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  OUTPUT_REDUCTION_FLAG_SPECS,
  outputReductionFlagsToArgs,
  parseOutputReductionFlags,
  type OutputReductionFlags,
} from "../../src/utils/outputReductionFlags";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Derive the full-record generator from the spec list itself, so adding a flag
// grows the generator automatically rather than silently under-testing it.
const flagsArb = fc.record(
  Object.fromEntries(OUTPUT_REDUCTION_FLAG_SPECS.map((spec) => [spec.field, fc.boolean()])),
) as fc.Arbitrary<OutputReductionFlags>;

const spec = fc.constantFrom(...OUTPUT_REDUCTION_FLAG_SPECS);
const cliSet = new Set(OUTPUT_REDUCTION_FLAG_SPECS.map((s) => s.cli));
const fieldsEqual = (a: OutputReductionFlags, b: OutputReductionFlags): boolean =>
  OUTPUT_REDUCTION_FLAG_SPECS.every((s) => a[s.field] === b[s.field]);

describe("parseOutputReductionFlags (property-based)", () => {
  test("with no CLI args and no env, every flag defaults off", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const flags = parseOutputReductionFlags([], {});
        return OUTPUT_REDUCTION_FLAG_SPECS.every((s) => flags[s.field] === false);
      }),
      RUN_OPTIONS,
    );
  });

  test("a single CLI flag enables exactly its own field", () => {
    fc.assert(
      fc.property(spec, (s) => {
        const flags = parseOutputReductionFlags([s.cli], {});
        return OUTPUT_REDUCTION_FLAG_SPECS.every(
          (other) => flags[other.field] === (other.field === s.field),
        );
      }),
      RUN_OPTIONS,
    );
  });

  test('an env var enables only its own flag, and only on the exact string "1"', () => {
    fc.assert(
      fc.property(spec, fc.oneof(fc.constant("1"), fc.string({ maxLength: 4 })), (s, value) => {
        const flags = parseOutputReductionFlags([], { [s.env]: value });
        // Check EVERY field, not just s.field: a spec that reused another spec's
        // env name would flip a second field here and be caught (cross-talk).
        const enabled = value === "1";
        return OUTPUT_REDUCTION_FLAG_SPECS.every(
          (other) => flags[other.field] === (other.field === s.field && enabled),
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("a present CLI flag wins over a disabling env var", () => {
    fc.assert(
      fc.property(
        spec,
        fc.string({ maxLength: 4 }).filter((v) => v !== "1"),
        (s, disabling) => {
          return parseOutputReductionFlags([s.cli], { [s.env]: disabling })[s.field] === true;
        },
      ),
      RUN_OPTIONS,
    );
  });
});

describe("outputReductionFlagsToArgs (property-based)", () => {
  test("emits exactly the CLI flags for the truthy fields, in spec order", () => {
    fc.assert(
      fc.property(flagsArb, (flags) => {
        const args = outputReductionFlagsToArgs(flags);
        const expected = OUTPUT_REDUCTION_FLAG_SPECS.filter((s) => flags[s.field]).map(
          (s) => s.cli,
        );
        return args.length === expected.length && args.every((a, i) => a === expected[i]);
      }),
      RUN_OPTIONS,
    );
  });

  test("every emitted arg is a known CLI flag whose field is truthy", () => {
    fc.assert(
      fc.property(flagsArb, (flags) => {
        const args = outputReductionFlagsToArgs(flags);
        return args.every((a) => cliSet.has(a));
      }),
      RUN_OPTIONS,
    );
  });
});

describe("outputReductionFlags round-trip (property-based)", () => {
  test("parse ∘ toArgs recovers a full flag record exactly", () => {
    fc.assert(
      fc.property(flagsArb, (flags) =>
        fieldsEqual(parseOutputReductionFlags(outputReductionFlagsToArgs(flags), {}), flags),
      ),
      RUN_OPTIONS,
    );
  });

  test("toArgs ∘ parse is a canonical fixed point over arbitrary argv", () => {
    // Feeding parse arbitrary argv (dupes, unknown tokens, any order) and then
    // re-serializing yields the same canonical, spec-ordered arg list twice.
    const argv = fc.array(
      fc.oneof(
        spec.map((s) => s.cli),
        fc.string({ maxLength: 8 }),
      ),
      { maxLength: 15 },
    );
    fc.assert(
      fc.property(argv, (args) => {
        const once = outputReductionFlagsToArgs(parseOutputReductionFlags(args, {}));
        const twice = outputReductionFlagsToArgs(parseOutputReductionFlags(once, {}));
        return once.length === twice.length && once.every((a, i) => a === twice[i]);
      }),
      RUN_OPTIONS,
    );
  });
});
