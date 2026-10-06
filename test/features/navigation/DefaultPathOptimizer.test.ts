import { expect, describe, test } from "bun:test";
import { DefaultPathOptimizer } from "../../../src/features/navigation/DefaultPathOptimizer";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import type {
  NavigationNode,
  NavigationEdge,
  PathResult,
} from "../../../src/utils/interfaces/NavigationGraph";

/**
 * DefaultPathOptimizer only depends on three NavigationGraphManager methods:
 * getNode(screen), getEdgesFrom(screen) (back-button verification walks forward
 * edges from the target to the current screen) and findPath(target) (forward
 * recommendation). We inject a narrow stub exposing exactly those so the heuristic
 * is exercised in isolation without touching a real graph/DB (issue #3067) and with
 * fully deterministic node/edge fixtures. DefaultPathOptimizer.realGraph.test.ts
 * covers the same heuristic against the real manager.
 */
function makeNode(overrides: Partial<NavigationNode> & { screenName: string }): NavigationNode {
  return {
    firstSeenAt: 0,
    lastSeenAt: 0,
    visitCount: 1,
    ...overrides,
  };
}

function edge(from: string, to: string): NavigationEdge {
  return { from, to, timestamp: 0, edgeType: "tool" };
}

function makeStub(config: {
  nodes?: Record<string, NavigationNode | undefined>;
  paths?: Record<string, PathResult>;
  edges?: NavigationEdge[];
}): NavigationGraphManager {
  const nodes = config.nodes ?? {};
  const paths = config.paths ?? {};
  const edges = config.edges ?? [];
  const stub = {
    async getNode(screen: string): Promise<NavigationNode | undefined> {
      return nodes[screen];
    },
    async getEdgesFrom(screen: string): Promise<NavigationEdge[]> {
      return edges.filter((candidate) => candidate.from === screen);
    },
    async findPath(target: string): Promise<PathResult> {
      return (
        paths[target] ?? {
          found: false,
          path: [],
          startScreen: "",
          targetScreen: target,
        }
      );
    },
  };
  return stub as unknown as NavigationGraphManager;
}

describe("DefaultPathOptimizer", function () {
  describe("shouldUseBackButton", function () {
    interface Row {
      name: string;
      currentScreen: string;
      targetScreen: string;
      currentDepth: number;
      node?: NavigationNode;
      edges?: NavigationEdge[];
      expectedUseBack: boolean;
      expectedBackPresses: number;
      reasonPattern: RegExp;
    }

    const rows: Row[] = [
      {
        name: "declines back when target screen is unknown to the graph",
        currentScreen: "B",
        targetScreen: "A",
        currentDepth: 3,
        node: undefined,
        expectedUseBack: false,
        expectedBackPresses: 0,
        reasonPattern: /not in navigation graph/,
      },
      {
        name: "declines back when target has no back stack information",
        currentScreen: "B",
        targetScreen: "A",
        currentDepth: 3,
        node: makeNode({ screenName: "A" }),
        expectedUseBack: false,
        expectedBackPresses: 0,
        reasonPattern: /no back stack information/,
      },
      {
        name: "declines back when current depth equals target depth",
        currentScreen: "B",
        targetScreen: "A",
        currentDepth: 2,
        node: makeNode({ screenName: "A", backStackDepth: 2 }),
        expectedUseBack: false,
        expectedBackPresses: 0,
        reasonPattern: /not greater than target depth/,
      },
      {
        name: "declines back when current depth is below target depth",
        currentScreen: "B",
        targetScreen: "A",
        currentDepth: 1,
        node: makeNode({ screenName: "A", backStackDepth: 4 }),
        expectedUseBack: false,
        expectedBackPresses: 0,
        reasonPattern: /not greater than target depth/,
      },
      {
        name: "uses a single back press for an unverified depth-1 parent",
        currentScreen: "B",
        targetScreen: "A",
        currentDepth: 2,
        node: makeNode({ screenName: "A", backStackDepth: 1 }),
        expectedUseBack: true,
        expectedBackPresses: 1,
        reasonPattern: /Depth difference is 1/,
      },
      {
        // Kills the `depthDifference <= 2` mutant of the `=== 1` guard: with no
        // known forward path and a depth gap of 2, back navigation is unsafe.
        name: "declines back for an unverified depth-2 gap with no known path",
        currentScreen: "C",
        targetScreen: "A",
        currentDepth: 3,
        node: makeNode({ screenName: "A", backStackDepth: 1 }),
        expectedUseBack: false,
        expectedBackPresses: 0,
        reasonPattern: /No known navigation path to verify safety/,
      },
      {
        name: "uses back when known path length matches the depth difference",
        currentScreen: "C",
        targetScreen: "A",
        currentDepth: 3,
        node: makeNode({ screenName: "A", backStackDepth: 1 }),
        edges: [edge("A", "B"), edge("B", "C")],
        expectedUseBack: true,
        expectedBackPresses: 2,
        reasonPattern: /matches depth difference/,
      },
      {
        name: "declines back when known path length disagrees with the depth difference",
        currentScreen: "C",
        targetScreen: "A",
        currentDepth: 3,
        node: makeNode({ screenName: "A", backStackDepth: 1 }),
        edges: [edge("A", "C")],
        expectedUseBack: false,
        expectedBackPresses: 0,
        reasonPattern: /doesn't match depth difference/,
      },
      {
        name: "ignores a current-to-target path: only target-to-current evidence counts",
        currentScreen: "C",
        targetScreen: "A",
        currentDepth: 3,
        node: makeNode({ screenName: "A", backStackDepth: 1 }),
        edges: [edge("C", "B"), edge("B", "A")],
        expectedUseBack: false,
        expectedBackPresses: 0,
        reasonPattern: /No known navigation path to verify safety/,
      },
      {
        name: "does not search past the depth difference for a longer forward path",
        currentScreen: "C",
        targetScreen: "A",
        currentDepth: 3,
        node: makeNode({ screenName: "A", backStackDepth: 1 }),
        edges: [edge("A", "X"), edge("X", "Y"), edge("Y", "C")],
        expectedUseBack: false,
        expectedBackPresses: 0,
        reasonPattern: /No known navigation path to verify safety/,
      },
    ];

    test.each(rows)("$name", async function (row) {
      const optimizer = new DefaultPathOptimizer(
        makeStub({
          nodes: { [row.targetScreen]: row.node },
          edges: row.edges,
        }),
      );

      const result = await optimizer.shouldUseBackButton(
        row.currentScreen,
        row.targetScreen,
        row.currentDepth,
      );

      expect(result.shouldUseBack).toBe(row.expectedUseBack);
      expect(result.backPresses).toBe(row.expectedBackPresses);
      expect(result.reason).toMatch(row.reasonPattern);
    });
  });

  describe("areInSameTask", function () {
    interface Row {
      name: string;
      node1?: NavigationNode;
      node2?: NavigationNode;
      expected: boolean;
    }

    const rows: Row[] = [
      {
        name: "returns true when both nodes share the same task id",
        node1: makeNode({ screenName: "A", taskId: 7 }),
        node2: makeNode({ screenName: "B", taskId: 7 }),
        expected: true,
      },
      {
        name: "returns false when the two nodes have different task ids",
        node1: makeNode({ screenName: "A", taskId: 7 }),
        node2: makeNode({ screenName: "B", taskId: 9 }),
        expected: false,
      },
      {
        name: "returns false when the first node is unknown",
        node1: undefined,
        node2: makeNode({ screenName: "B", taskId: 7 }),
        expected: false,
      },
      {
        name: "returns false when the second node is unknown",
        node1: makeNode({ screenName: "A", taskId: 7 }),
        node2: undefined,
        expected: false,
      },
      {
        name: "returns false when either node has no task id",
        node1: makeNode({ screenName: "A", taskId: 7 }),
        node2: makeNode({ screenName: "B" }),
        expected: false,
      },
    ];

    test.each(rows)("$name", async function (row) {
      const optimizer = new DefaultPathOptimizer(
        makeStub({ nodes: { A: row.node1, B: row.node2 } }),
      );
      expect(await optimizer.areInSameTask("A", "B")).toBe(row.expected);
    });
  });

  describe("getNavigationRecommendation", function () {
    test("recommends back navigation when the back heuristic applies", async function () {
      const optimizer = new DefaultPathOptimizer(
        makeStub({
          nodes: { A: makeNode({ screenName: "A", backStackDepth: 1 }) },
          paths: { A: { found: false, path: [], startScreen: "", targetScreen: "A" } },
        }),
      );

      const result = await optimizer.getNavigationRecommendation("A", "B", 2);

      expect(result.method).toBe("back");
      expect(result.backPresses).toBe(1);
    });

    test("recommends forward navigation when a known path exists but back is unsafe", async function () {
      const optimizer = new DefaultPathOptimizer(
        makeStub({
          nodes: { A: makeNode({ screenName: "A" }) },
          paths: {
            A: {
              found: true,
              path: [edge("B", "A")],
              startScreen: "B",
              targetScreen: "A",
            },
          },
        }),
      );

      const result = await optimizer.getNavigationRecommendation("A", "B", 0);

      expect(result.method).toBe("forward");
      expect(result.reason).toMatch(/1 steps/);
    });

    test("returns unknown when no path to the target screen is known", async function () {
      const optimizer = new DefaultPathOptimizer(makeStub({}));

      const result = await optimizer.getNavigationRecommendation("Nowhere", "Here", 2);

      expect(result.method).toBe("unknown");
    });
  });
});
