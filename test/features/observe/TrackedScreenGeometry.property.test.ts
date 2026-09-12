import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { CoordinateSpace } from "../../../src/daemon/canonicalPixels";
import {
  type ScreenGeometryBinding,
  screenshotBindingPushOptions,
  TrackedScreenGeometry,
} from "../../../src/features/observe/TrackedScreenGeometry";

/**
 * Property-based coverage for the capture-provenance rule both CtrlProxy clients share (issue
 * #3348). The example suite in TrackedScreenGeometry.test.ts nails the named scenarios; these
 * properties assert the underlying invariants hold for arbitrary geometry sequences — in
 * particular the nativeScale dimension of "any change of identity resets provenance", which the
 * examples exercise only for width/height and coordinateSpace.
 *
 * Pinned seed (see Backoff.property.test.ts): the same generated cases run every CI invocation, so
 * a counterexample is reproducible rather than a heisenbug.
 */
const RUN_OPTIONS = { seed: 4_413_348, numRuns: 400 } as const;

// Finite, strictly-positive dimensions — the only inputs update() accepts. A mix of integers (real
// pixel dimensions) and non-integer doubles (to catch any accidental integer assumption).
const validDim: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 20_000 }),
  fc.double({ min: 0.5, max: 20_000, noNaN: true, noDefaultInfinity: true }),
);

// Values update() must reject: non-finite, zero, or negative.
const invalidDim: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  fc.integer({ min: -20_000, max: 0 }),
  fc.double({ min: -20_000, max: -0.5, noNaN: true, noDefaultInfinity: true }),
);

const coordinateSpace: fc.Arbitrary<CoordinateSpace | undefined> = fc.constantFrom<
  CoordinateSpace | undefined
>("px", undefined);

// nativeScale is not validated by the module (only width/height are), so any finite value or
// undefined is a legal input. Kept finite so identity comparisons behave (NaN !== NaN would defeat
// the idempotence properties by design, which is a separate corner from the invariants under test).
const nativeScale: fc.Arbitrary<number | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.double({ min: 0.1, max: 8, noNaN: true, noDefaultInfinity: true }),
);

interface Geometry {
  width: number;
  height: number;
  coordinateSpace: CoordinateSpace | undefined;
  nativeScale: number | undefined;
}

const validGeometry: fc.Arbitrary<Geometry> = fc.record({
  width: validDim,
  height: validDim,
  coordinateSpace,
  nativeScale,
});

const captureSequence: fc.Arbitrary<number> = fc.integer({ min: -5, max: 1_000_000 });

const apply = (tracker: TrackedScreenGeometry, g: Geometry): void =>
  tracker.update(g.width, g.height, g.coordinateSpace, g.nativeScale);

const sameGeometry = (a: Geometry, b: Geometry): boolean =>
  a.width === b.width &&
  a.height === b.height &&
  a.coordinateSpace === b.coordinateSpace &&
  a.nativeScale === b.nativeScale;

// A tracker driven through arbitrary prior activity, so properties about the NEXT operation hold
// regardless of the state it starts from rather than only from a fresh instance.
const priorActivity: fc.Arbitrary<Array<Geometry | number>> = fc.array(
  fc.oneof(validGeometry, captureSequence),
  { maxLength: 5 },
);

const drive = (steps: Array<Geometry | number>): TrackedScreenGeometry => {
  const tracker = new TrackedScreenGeometry();
  for (const step of steps) {
    if (typeof step === "number") {
      tracker.markForwarded(step);
    } else {
      apply(tracker, step);
    }
  }
  return tracker;
};

describe("TrackedScreenGeometry.update (property-based)", () => {
  test("unusable geometry fully clears the tracker, whatever the prior state", () => {
    fc.assert(
      fc.property(
        priorActivity,
        invalidDim,
        validDim,
        fc.boolean(),
        coordinateSpace,
        nativeScale,
        (prior, bad, ok, badIsWidth, cs, ns) => {
          const tracker = drive(prior);
          const width = badIsWidth ? bad : ok;
          const height = badIsWidth ? ok : bad;
          tracker.update(width, height, cs, ns);
          // Cleared means: no dimensions, no provenance, nothing to bind.
          expect(tracker.width).toBeNull();
          expect(tracker.height).toBeNull();
          expect(tracker.isForwarded).toBe(false);
          expect(tracker.bind()).toBeNull();
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("valid geometry is recorded but never claims provenance until it is forwarded", () => {
    fc.assert(
      fc.property(priorActivity, validGeometry, (prior, g) => {
        const tracker = drive(prior);
        apply(tracker, g);
        expect(tracker.width).toBe(g.width);
        expect(tracker.height).toBe(g.height);
        // Fresh geometry the daemon has not seen must fail closed.
        expect(tracker.isForwarded).toBe(false);
        expect(tracker.bind()).toBeNull();
      }),
      RUN_OPTIONS,
    );
  });

  test("re-deriving identical geometry keeps provenance; any change of identity resets it", () => {
    fc.assert(
      fc.property(validGeometry, captureSequence, validGeometry, (first, seq, second) => {
        const tracker = new TrackedScreenGeometry();
        apply(tracker, first);
        tracker.markForwarded(seq);
        expect(tracker.isForwarded).toBe(true);

        apply(tracker, second);
        if (sameGeometry(first, second)) {
          // Idempotent re-derivation must not flap the vouch off and strand control fail-closed.
          expect(tracker.isForwarded).toBe(true);
          expect(tracker.bind()?.captureSequence).toBe(seq);
        } else {
          // A change in ANY identity component (width, height, coordinateSpace, or nativeScale)
          // means the daemon has not seen a hierarchy carrying it yet.
          expect(tracker.isForwarded).toBe(false);
          expect(tracker.bind()).toBeNull();
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("a nativeScale-only flip at identical pixels still resets provenance", () => {
    // The example suite covers the coordinateSpace flip but not nativeScale; assert the same reset
    // rule holds when only the physical-threshold metadata moves.
    fc.assert(
      fc.property(
        validDim,
        validDim,
        coordinateSpace,
        captureSequence,
        fc.tuple(nativeScale, nativeScale).filter(([a, b]) => a !== b),
        (width, height, cs, seq, [nsA, nsB]) => {
          const tracker = new TrackedScreenGeometry();
          tracker.update(width, height, cs, nsA);
          tracker.markForwarded(seq);
          tracker.update(width, height, cs, nsB);
          expect(tracker.isForwarded).toBe(false);
          expect(tracker.bind()).toBeNull();
        },
      ),
      RUN_OPTIONS,
    );
  });
});

describe("TrackedScreenGeometry.markForwarded / bind (property-based)", () => {
  test("markForwarded cannot manufacture provenance when no geometry is cached", () => {
    fc.assert(
      fc.property(fc.array(invalidDim, { maxLength: 3 }), captureSequence, (bads, seq) => {
        const tracker = new TrackedScreenGeometry();
        // Any number of unusable updates leaves nothing cached to vouch for.
        for (const bad of bads) {
          tracker.update(bad, bad);
        }
        tracker.markForwarded(seq);
        expect(tracker.isForwarded).toBe(false);
        expect(tracker.bind()).toBeNull();
      }),
      RUN_OPTIONS,
    );
  });

  test("bind reflects the exact current geometry and sequence, with optional fields present iff set", () => {
    fc.assert(
      fc.property(validGeometry, captureSequence, (g, seq) => {
        const tracker = new TrackedScreenGeometry();
        apply(tracker, g);
        tracker.markForwarded(seq);
        const binding = tracker.bind();
        expect(binding).not.toBeNull();
        const expected: ScreenGeometryBinding = {
          captureSequence: seq,
          width: g.width,
          height: g.height,
        };
        // coordinateSpace rides the binding only when truthy (legacy point-space omits it).
        if (g.coordinateSpace) {
          expected.coordinateSpace = g.coordinateSpace;
        }
        // nativeScale rides only when defined (undefined vs 0 is a meaningful distinction).
        if (g.nativeScale !== undefined) {
          expected.nativeScale = g.nativeScale;
        }
        expect(binding).toEqual(expected);
        expect("coordinateSpace" in binding!).toBe(Boolean(g.coordinateSpace));
        expect("nativeScale" in binding!).toBe(g.nativeScale !== undefined);
      }),
      RUN_OPTIONS,
    );
  });

  test("the latest markForwarded wins; a previously returned binding is an immutable snapshot", () => {
    fc.assert(
      fc.property(validGeometry, captureSequence, captureSequence, (g, first, second) => {
        const tracker = new TrackedScreenGeometry();
        apply(tracker, g);
        tracker.markForwarded(first);
        const snapshot = tracker.bind();
        expect(snapshot?.captureSequence).toBe(first);

        tracker.markForwarded(second);
        // The earlier binding must not be relabelled by a later forward.
        expect(snapshot?.captureSequence).toBe(first);
        // A fresh bind reflects the newest identity (no geometry change between the two forwards).
        expect(tracker.bind()?.captureSequence).toBe(second);
      }),
      RUN_OPTIONS,
    );
  });

  test("clear always returns to the empty state", () => {
    fc.assert(
      fc.property(priorActivity, (prior) => {
        const tracker = drive(prior);
        tracker.clear();
        expect(tracker.width).toBeNull();
        expect(tracker.height).toBeNull();
        expect(tracker.isForwarded).toBe(false);
        expect(tracker.bind()).toBeNull();
      }),
      RUN_OPTIONS,
    );
  });
});

describe("screenshotBindingPushOptions (property-based)", () => {
  const bindingArb: fc.Arbitrary<ScreenGeometryBinding> = fc.record({
    captureSequence,
    width: validDim,
    height: validDim,
    coordinateSpace,
    nativeScale,
  });

  test("passes the capture identity through and carries optional fields iff they are set", () => {
    fc.assert(
      fc.property(bindingArb, (binding) => {
        const options = screenshotBindingPushOptions(binding);
        expect(options.captureSequence).toBe(binding.captureSequence);
        expect("coordinateSpace" in options).toBe(Boolean(binding.coordinateSpace));
        expect("nativeScale" in options).toBe(binding.nativeScale !== undefined);
        if (binding.coordinateSpace) {
          expect(options.coordinateSpace).toBe(binding.coordinateSpace);
        }
        if (binding.nativeScale !== undefined) {
          expect(options.nativeScale).toBe(binding.nativeScale);
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("an absent binding yields an all-undefined identity with no optional fields", () => {
    const options = screenshotBindingPushOptions(undefined);
    expect(options.captureSequence).toBeUndefined();
    expect("coordinateSpace" in options).toBe(false);
    expect("nativeScale" in options).toBe(false);
  });

  test("the push options agree with what a forwarded tracker binds", () => {
    // The free function and TrackedScreenGeometry.bind must apply the same optional-presence rules,
    // so a frame pushed from a binding carries exactly the metadata bind established.
    fc.assert(
      fc.property(validGeometry, captureSequence, (g, seq) => {
        const tracker = new TrackedScreenGeometry();
        apply(tracker, g);
        tracker.markForwarded(seq);
        const binding = tracker.bind();
        const options = screenshotBindingPushOptions(binding ?? undefined);
        expect(options.captureSequence).toBe(seq);
        expect("coordinateSpace" in options).toBe("coordinateSpace" in binding!);
        expect("nativeScale" in options).toBe("nativeScale" in binding!);
      }),
      RUN_OPTIONS,
    );
  });
});
