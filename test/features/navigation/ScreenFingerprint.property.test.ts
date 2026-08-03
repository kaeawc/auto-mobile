import { createHash } from "crypto";
import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  ScreenFingerprint,
  AccessibilityHierarchy,
  FingerprintConfidence,
  FingerprintMethod,
} from "../../../src/features/navigation/ScreenFingerprint";

// AccessibilityNode itself is not exported from the source module (only
// AccessibilityHierarchy is), so this is a local, structurally-compatible
// stand-in covering just the fields this file's generator produces —
// `node` is always an array here, which the real type also allows.
interface AccessibilityNode {
  text?: string;
  "resource-id"?: string;
  className?: string;
  scrollable?: string;
  selected?: string;
  node?: AccessibilityNode[];
}

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
// numRuns is lower than the repo default (300) because each run generates and
// filters a nested tree, which is pricier per-iteration than the scalar cases
// elsewhere; 150 keeps the whole file well under a second.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 150 } as const;

// Lowercase-letters-and-digits charset only. It is deliberately disjoint from
// every substring `ScreenFingerprint` treats specially: "navigation.",
// "com.android.systemui", "android:id/", "keyboard", "inputmethod", "Delete",
// "Enter", "emoji", "Shift" (all require an uppercase letter or a character
// outside this alphabet), so short strings drawn from it can never
// accidentally trip a filter branch this file isn't testing.
const safeChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split(""));
const shortSuffix = fc.string({ unit: safeChar, maxLength: 5 });

// Prefixed so the values can never collide with a reserved prefix/substring
// above, and `text` never satisfies TIME_PATTERN/NUMBER_PATTERN/PERCENT_PATTERN
// (all of which require the string to be pure digits, so a leading letter is
// enough to dodge every one of them).
const safeText = shortSuffix.map(s => `t${s}`);
const safeResourceId = shortSuffix.map(s => `rid${s}`);
const safeClassName = shortSuffix.map(s => `Cls${s}`);
const trueOrAbsent = fc.option(fc.constant("true" as const), { nil: undefined });

/**
 * Recursive AccessibilityNode generator, depth-capped at 3 and fanout-capped
 * at 3 children, built by direct recursion on a bounded integer (not
 * fc.letrec) since the depth bound is a small compile-time constant.
 */
function nodeArbitrary(depth: number): fc.Arbitrary<AccessibilityNode> {
  const scalarFields = {
    "text": fc.option(safeText, { nil: undefined }),
    "resource-id": fc.option(safeResourceId, { nil: undefined }),
    "className": fc.option(safeClassName, { nil: undefined }),
    "scrollable": trueOrAbsent,
    "selected": trueOrAbsent,
  };

  if (depth <= 0) {
    return fc.record(scalarFields);
  }

  return fc.record({
    ...scalarFields,
    node: fc.option(fc.array(nodeArbitrary(depth - 1), { maxLength: 3 }), { nil: undefined }),
  });
}

const treeArbitrary = nodeArbitrary(3);

// Totality also needs the canonical degenerate cases (empty object, no
// node/text/resource-id at all) exercised deterministically rather than left
// to chance, alongside the generated trees (which already reach the depth cap).
const totalityTreeArbitrary = fc.oneof(fc.constant<AccessibilityNode>({}), treeArbitrary);

const timestamp = fc.integer({ min: 0, max: 10_000_000 });
const packageName = shortSuffix.map(s => `pkg.${s}`);

function toHierarchy(hierarchy: AccessibilityNode, updatedAt: number, pkg: string): AccessibilityHierarchy {
  return { updatedAt, packageName: pkg, hierarchy };
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Walk `path` (child indices) from the root, clamping each index into range
 * and stopping early if a node has no children, then stamp a navigation
 * resource-id onto whichever node the walk lands on. Operates on a deep
 * clone so the caller's original tree is left untouched.
 */
function injectNavigationId(root: AccessibilityNode, path: number[], navId: string): AccessibilityNode {
  const clone = structuredClone(root);
  let current = clone;

  for (const step of path) {
    const children = Array.isArray(current.node)
      ? current.node
      : current.node
        ? [current.node]
        : [];
    if (children.length === 0) {break;}
    current = children[step % children.length];
  }

  current["resource-id"] = navId;
  return clone;
}

describe("ScreenFingerprint.compute (property-based)", () => {
  test("hash is a pure function of tree content — independent of object identity, updatedAt, and packageName", () => {
    fc.assert(
      fc.property(treeArbitrary, timestamp, timestamp, packageName, packageName, (tree, t1, t2, p1, p2) => {
        const clone = structuredClone(tree);

        const result1 = ScreenFingerprint.compute(toHierarchy(tree, t1, p1));
        const result2 = ScreenFingerprint.compute(toHierarchy(clone, t2, p2));

        return result1.hash === result2.hash;
      }),
      RUN_OPTIONS
    );
  });

  // filterHierarchyEnhanced maps children in array order and assigns the
  // filtered array directly, so JSON.stringify (and therefore the hash) is
  // sensitive to child order — reordering is NOT a no-op in general. This is
  // a real fragility (screen-revisit detection can miss a match if the same
  // children reappear in a different order), documented here rather than
  // asserted away. To keep the property deterministic (no reliance on random
  // children happening to differ), the two children are tagged with fixed,
  // distinct discriminator resource-ids that filtering always preserves.
  test("reversing two structurally distinct children changes the hash (order-sensitivity is real, not a false property)", () => {
    fc.assert(
      fc.property(treeArbitrary, treeArbitrary, timestamp, (subtreeA, subtreeB, t) => {
        const childA: AccessibilityNode = { "resource-id": "discA", "node": subtreeA.node };
        const childB: AccessibilityNode = { "resource-id": "discB", "node": subtreeB.node };

        const forward: AccessibilityNode = { className: "Parent", node: [childA, childB] };
        const reversed: AccessibilityNode = { className: "Parent", node: [childB, childA] };

        const hashForward = ScreenFingerprint.compute(toHierarchy(forward, t, "pkg.a")).hash;
        const hashReversed = ScreenFingerprint.compute(toHierarchy(reversed, t, "pkg.a")).hash;

        return hashForward !== hashReversed;
      }),
      RUN_OPTIONS
    );
  });

  test("compute never throws and always returns a well-formed hash and a valid confidence", () => {
    const validConfidences: FingerprintConfidence[] = [
      FingerprintConfidence.VERY_HIGH,
      FingerprintConfidence.HIGH,
      FingerprintConfidence.MEDIUM,
      FingerprintConfidence.LOW_MEDIUM,
    ];

    fc.assert(
      fc.property(totalityTreeArbitrary, timestamp, packageName, (tree, t, pkg) => {
        const result = ScreenFingerprint.compute(toHierarchy(tree, t, pkg));

        return (
          /^[0-9a-f]{64}$/.test(result.hash) &&
          validConfidences.includes(result.confidence)
        );
      }),
      RUN_OPTIONS
    );
  });

  test("a navigation.* resource-id anywhere in the tree short-circuits to the NAVIGATION_ID tier", () => {
    fc.assert(
      fc.property(
        treeArbitrary,
        fc.array(fc.nat({ max: 2 }), { maxLength: 3 }),
        shortSuffix,
        timestamp,
        (tree, path, idSuffix, t) => {
          const navId = `navigation.${idSuffix}`;
          const mutated = injectNavigationId(tree, path, navId);

          const result = ScreenFingerprint.compute(toHierarchy(mutated, t, "pkg.a"));

          return (
            result.method === FingerprintMethod.NAVIGATION_ID &&
            result.confidence === FingerprintConfidence.VERY_HIGH &&
            result.navigationId === navId &&
            result.hash === sha256Hex(`nav:${navId}`)
          );
        }
      ),
      RUN_OPTIONS
    );
  });
});
