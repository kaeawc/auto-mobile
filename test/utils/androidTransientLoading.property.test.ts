import { describe, test } from "bun:test";
import fc from "fast-check";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import { androidViewHierarchyIndicatesLikelyBlockingLoading } from "../../src/utils/androidTransientLoading";
import { FakeElementParser } from "../fakes/FakeElementParser";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Concrete representative strings rather than re-encoding the module's regexes:
// the property tests traversal + detection, not the hint patterns themselves.
const LOADING_RID = "com.app:id/loading_indicator";
const LOADING_CLASS = "android.widget.ProgressBar";
const BENIGN_RID = "com.app:id/title_text";
const BENIGN_CLASS = "android.widget.TextView";

interface RawNode {
  loading: boolean;
  kind: "rid" | "class";
  children: RawNode[];
}
type HierNode = { props: Record<string, string>; node: HierNode[] };

// A depth-bounded forest of nodes, each optionally a loading node signalled via
// either its resource-id or its class.
const rawNodeAtDepth = (depth: number): fc.Arbitrary<RawNode> =>
  fc.record({
    loading: fc.boolean(),
    kind: fc.constantFrom<"rid" | "class">("rid", "class"),
    children:
      depth <= 0
        ? fc.constant([] as RawNode[])
        : fc.array(rawNodeAtDepth(depth - 1), { maxLength: 3 }),
  });
const forest = fc.array(rawNodeAtDepth(3), { maxLength: 4 });

const anyLoading = (nodes: RawNode[]): boolean =>
  nodes.some((n) => n.loading || anyLoading(n.children));

const toHier = (raw: RawNode): HierNode => {
  const props: Record<string, string> = { "resource-id": BENIGN_RID, class: BENIGN_CLASS };
  if (raw.loading) {
    if (raw.kind === "rid") {
      props["resource-id"] = LOADING_RID;
    } else {
      props.class = LOADING_CLASS;
    }
  }
  return { props, node: raw.children.map(toHier) };
};

// Reuse the shared fake but read per-node props (the base returns one shared bag).
class PropsReadingParser extends FakeElementParser {
  extractNodeProperties(node: any): any {
    return node?.props ?? {};
  }
}

const detect = (roots: RawNode[]): boolean => {
  const parser = new PropsReadingParser();
  parser.nextRootNodes = roots.map(toHier) as any;
  parser.nextWindowRootGroups = [];
  return androidViewHierarchyIndicatesLikelyBlockingLoading({} as ViewHierarchyResult, parser);
};

describe("androidViewHierarchyIndicatesLikelyBlockingLoading (property-based)", () => {
  test("is total — a boolean for any forest, never throwing", () => {
    fc.assert(
      fc.property(forest, (roots) => typeof detect(roots) === "boolean"),
      RUN_OPTIONS,
    );
  });

  test("is true iff a loading node exists anywhere in the tree (membership)", () => {
    fc.assert(
      fc.property(forest, (roots) => detect(roots) === anyLoading(roots)),
      RUN_OPTIONS,
    );
  });

  test("a forest with no loading node is never flagged", () => {
    const benignForest = fc.array(
      fc.record({
        loading: fc.constant(false),
        kind: fc.constant<"rid">("rid"),
        children: fc.constant([] as RawNode[]),
      }),
      { maxLength: 6 },
    );
    fc.assert(
      fc.property(benignForest, (roots) => detect(roots) === false),
      RUN_OPTIONS,
    );
  });

  test("appending a loading root always flags the tree (monotonic)", () => {
    const loadingRoot: RawNode = { loading: true, kind: "rid", children: [] };
    fc.assert(
      fc.property(forest, (roots) => detect([...roots, loadingRoot])),
      RUN_OPTIONS,
    );
  });

  test("an empty hierarchy is never flagged", () => {
    fc.assert(
      fc.property(fc.constant([] as RawNode[]), (roots) => detect(roots) === false),
      RUN_OPTIONS,
    );
  });
});
