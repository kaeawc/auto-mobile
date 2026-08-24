import { describe, test } from "bun:test";
import fc from "fast-check";
import type {
  FocusAnchor,
  NormalizedRegion,
  ObserveScopeInput,
} from "../../../../src/models/ObserveScope";
import {
  buildObserveScopeConfig,
  readBounds,
  type ObserveScopeFlags,
} from "../../../../src/features/observe/output/ObserveScopeExperiments";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const isNumberField = (v: unknown): boolean => typeof v === "number";

describe("readBounds (property-based)", () => {
  const coord = fc.integer({ min: -100_000, max: 100_000 });

  test("reads the positional [l,t,r,b] tuple form", () => {
    fc.assert(
      fc.property(coord, coord, coord, coord, (l, t, r, b) => {
        const parsed = readBounds([l, t, r, b]);
        return (
          parsed !== null &&
          parsed.left === l &&
          parsed.top === t &&
          parsed.right === r &&
          parsed.bottom === b
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("reads the {left,top,right,bottom} object form, and both forms agree", () => {
    fc.assert(
      fc.property(coord, coord, coord, coord, (l, t, r, b) => {
        const fromObject = readBounds({ left: l, top: t, right: r, bottom: b });
        const fromTuple = readBounds([l, t, r, b]);
        return (
          fromObject !== null &&
          fromTuple !== null &&
          fromObject.left === fromTuple.left &&
          fromObject.top === fromTuple.top &&
          fromObject.right === fromTuple.right &&
          fromObject.bottom === fromTuple.bottom
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("never throws — returns null or a fully numeric bounds — for arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const parsed = readBounds(value);
        return (
          parsed === null ||
          (isNumberField(parsed.left) &&
            isNumberField(parsed.top) &&
            isNumberField(parsed.right) &&
            isNumberField(parsed.bottom))
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("rejects arrays that are not exactly four numbers", () => {
    const wrongLength = fc.array(coord, { maxLength: 8 }).filter((a) => a.length !== 4);
    const nonNumberInTuple = fc
      .tuple(coord, coord, coord, coord, fc.integer({ min: 0, max: 3 }))
      .map(([a, b, c, d, idx]) => {
        const arr: unknown[] = [a, b, c, d];
        arr[idx] = "not-a-number";
        return arr;
      });
    fc.assert(
      fc.property(fc.oneof(wrongLength, nonNumberInTuple), (value) => readBounds(value) === null),
      RUN_OPTIONS,
    );
  });

  test("rejects primitives and objects missing a numeric field", () => {
    const missingField = fc
      .tuple(
        fc.integer(),
        fc.integer(),
        fc.integer(),
        fc.constantFrom("left", "top", "right", "bottom"),
      )
      .map(([l, t, r, drop]) => {
        const obj: Record<string, unknown> = { left: l, top: t, right: r, bottom: l };
        delete obj[drop];
        return obj;
      });
    const primitive = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
    fc.assert(
      fc.property(fc.oneof(missingField, primitive), (value) => readBounds(value) === null),
      RUN_OPTIONS,
    );
  });
});

const flags: fc.Arbitrary<ObserveScopeFlags> = fc.record({
  focus: fc.boolean(),
  overview: fc.boolean(),
  region: fc.boolean(),
});

const focusAnchor: fc.Arbitrary<FocusAnchor> = fc.record(
  {
    resourceId: fc.option(fc.string(), { nil: undefined }),
    text: fc.option(fc.string(), { nil: undefined }),
  },
  { requiredKeys: [] },
);
const unit = fc.double({ min: 0, max: 1, noNaN: true });
const region: fc.Arbitrary<NormalizedRegion> = fc.record({
  x1: unit,
  y1: unit,
  x2: unit,
  y2: unit,
});

const scope: fc.Arbitrary<ObserveScopeInput | undefined> = fc.option(
  fc.record(
    {
      focus: fc.oneof(fc.boolean(), focusAnchor),
      region: fc.oneof(fc.boolean(), region),
      overview: fc.boolean(),
    },
    { requiredKeys: [] },
  ),
  { nil: undefined },
);

const requested = (dim: boolean | object | undefined): boolean =>
  dim !== undefined && dim !== false;

describe("buildObserveScopeConfig (property-based)", () => {
  test("each dimension is on iff its flag is enabled AND the call requested it", () => {
    fc.assert(
      fc.property(flags, scope, (f, s) => {
        const cfg = buildObserveScopeConfig(f, s);
        return (
          cfg.focus === (f.focus && requested(s?.focus)) &&
          cfg.region === (f.region && requested(s?.region)) &&
          cfg.overview === (f.overview && s?.overview === true)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("a disabled flag forces its dimension off regardless of the request", () => {
    fc.assert(
      fc.property(flags, scope, (f, s) => {
        const cfg = buildObserveScopeConfig(
          { ...f, focus: false, region: false, overview: false },
          s,
        );
        return cfg.focus === false && cfg.region === false && cfg.overview === false;
      }),
      RUN_OPTIONS,
    );
  });

  test("an enabled dimension implies its flag was enabled", () => {
    fc.assert(
      fc.property(flags, scope, (f, s) => {
        const cfg = buildObserveScopeConfig(f, s);
        return (
          (!cfg.focus || f.focus) && (!cfg.region || f.region) && (!cfg.overview || f.overview)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("focusAnchor/regionBox are the object forms of the request, else undefined", () => {
    fc.assert(
      fc.property(flags, scope, (f, s) => {
        const cfg = buildObserveScopeConfig(f, s);
        const expectedAnchor = s && typeof s.focus === "object" ? s.focus : undefined;
        const expectedBox = s && typeof s.region === "object" ? s.region : undefined;
        return cfg.focusAnchor === expectedAnchor && cfg.regionBox === expectedBox;
      }),
      RUN_OPTIONS,
    );
  });
});
