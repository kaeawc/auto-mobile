import { describe, expect, test } from "bun:test";
import type { NavigationEdge, NavigationNode } from "../../../src/db/types";
import { TestCoverageAnalyzer } from "../../../src/features/navigation/TestCoverageAnalyzer";
import { FakeTimer } from "../../fakes/FakeTimer";

type CoverageAnalysis = Awaited<
  ReturnType<FakeCoverageRepository["getAggregatedCoverageAnalysis"]>
>;

class FakeCoverageRepository {
  getAnalysisCallCount = 0;

  constructor(
    private readonly analysis: {
      totalNodes: number;
      coveredNodes: number;
      uncoveredNodes: NavigationNode[];
      totalEdges: number;
      coveredEdges: number;
      uncoveredEdges: NavigationEdge[];
      coveragePercentage: number;
    },
  ) {}

  async getAggregatedCoverageAnalysis(_appId: string): Promise<typeof this.analysis> {
    this.getAnalysisCallCount++;
    return this.analysis;
  }
}

class FakeNavigationRepository {
  getNodesCallCount = 0;
  getEdgesCallCount = 0;

  constructor(
    private readonly nodes: NavigationNode[],
    private readonly edges: NavigationEdge[],
  ) {}

  async getNodes(_appId: string): Promise<NavigationNode[]> {
    this.getNodesCallCount++;
    return this.nodes;
  }

  async getEdges(_appId: string): Promise<NavigationEdge[]> {
    this.getEdgesCallCount++;
    return this.edges;
  }
}

// These arrays keep the single-linear-scan RATCHET (a second full iteration
// throws) but no longer ban specific Array methods. The iterationCount guard
// pins the observable O(n) property; filter()/some()/find() bans only dictated
// *how* the indexing is done, over-constraining the implementation (#4171).
class NoRepeatedScanEdges extends Array<NavigationEdge> {
  iterationCount = 0;

  override [Symbol.iterator](): IterableIterator<NavigationEdge> {
    this.iterationCount++;
    if (this.iterationCount > 1) {
      throw new Error("expected edges to be indexed once, not scanned again per gap");
    }
    return super[Symbol.iterator]();
  }
}

class NoRepeatedScanNodes extends Array<NavigationNode> {
  iterationCount = 0;

  override [Symbol.iterator](): IterableIterator<NavigationNode> {
    this.iterationCount++;
    if (this.iterationCount > 1) {
      throw new Error("expected nodes to be indexed once, not scanned again per gap");
    }
    return super[Symbol.iterator]();
  }
}

function node(id: number, screenName: string, visitCount: number): NavigationNode {
  return {
    id,
    app_id: "com.example.app",
    screen_name: screenName,
    first_seen_at: 1000,
    last_seen_at: 1000,
    visit_count: visitCount,
    back_stack_depth: null,
    task_id: null,
    screenshot_path: null,
    created_at: "2024-01-01T00:00:00.000Z",
  };
}

function edge(id: number, fromScreen: string, toScreen: string): NavigationEdge {
  return {
    id,
    app_id: "com.example.app",
    from_screen: fromScreen,
    to_screen: toScreen,
    tool_name: "tapOn",
    tool_args: null,
    timestamp: 1000,
    created_at: "2024-01-01T00:00:00.000Z",
  };
}

function analyzerFor(
  analysis: CoverageAnalysis,
  nodes: NavigationNode[],
  edges: NavigationEdge[],
  timer = new FakeTimer(),
): {
  analyzer: TestCoverageAnalyzer;
  coverageRepository: FakeCoverageRepository;
  navigationRepository: FakeNavigationRepository;
  timer: FakeTimer;
} {
  const coverageRepository = new FakeCoverageRepository(analysis);
  const navigationRepository = new FakeNavigationRepository(nodes, edges);

  return {
    analyzer: new TestCoverageAnalyzer({
      coverageRepository,
      navigationRepository,
      timer,
    }),
    coverageRepository,
    navigationRepository,
    timer,
  };
}

describe("TestCoverageAnalyzer", () => {
  test("scores critical coverage gaps in a single pass over nodes and edges", async () => {
    const nodes = new NoRepeatedScanNodes(
      node(1, "Home", 10),
      node(2, "Search", 6),
      node(3, "Details", 8),
      node(4, "Settings", 2),
    );
    const edges = new NoRepeatedScanEdges(
      edge(10, "Home", "Search"),
      edge(11, "Search", "Details"),
      edge(12, "Home", "Settings"),
    );
    const analysis = {
      totalNodes: nodes.length,
      coveredNodes: 2,
      uncoveredNodes: [nodes[2]],
      totalEdges: edges.length,
      coveredEdges: 2,
      uncoveredEdges: [edges[1]],
      coveragePercentage: 60,
    };
    const timer = new FakeTimer();
    timer.setCurrentTime(123456);
    const { analyzer, coverageRepository, navigationRepository } = analyzerFor(
      analysis,
      nodes,
      edges,
      timer,
    );

    const report = await analyzer.generateReport("com.example.app");

    expect(report.generatedAt).toBe(123456);
    expect(coverageRepository.getAnalysisCallCount).toBe(1);
    expect(navigationRepository.getNodesCallCount).toBe(1);
    expect(navigationRepository.getEdgesCallCount).toBe(1);
    expect(nodes.iterationCount).toBe(1);
    expect(edges.iterationCount).toBe(1);
    expect(report.criticalGaps).toHaveLength(2);
    expect(report.criticalGaps.map((gap) => gap.id)).toEqual([11, 3]);
    const nodeGap = report.criticalGaps.find((gap) => gap.type === "node");
    const edgeGap = report.criticalGaps.find((gap) => gap.type === "edge");
    expect(nodeGap).toMatchObject({
      type: "node",
      id: 3,
      screenName: "Details",
      criticalityScore: 65,
    });
    expect(nodeGap?.recommendation).toContain("shallow in navigation tree");
    expect(edgeGap).toMatchObject({
      type: "edge",
      id: 11,
      fromScreen: "Search",
      toScreen: "Details",
      criticalityScore: 85,
    });
    expect(edgeGap?.recommendation).toContain("shallow in navigation tree");
    expect(report.recommendations).toEqual([
      "Overall coverage is 60.0% - add tests for critical user journeys to reach 80%+ coverage.",
      "2 high-priority coverage gap(s) identified in frequently-used, shallow screens. Prioritize testing these areas.",
      "1 screen(s) have no test coverage. Top uncovered: Details",
    ]);
    expect(report.suggestedScenarios).toEqual([
      {
        title: "Cover Critical Screens",
        description:
          "Test 1 frequently-accessed screen(s) that currently have no coverage. These are shallow in the navigation tree and likely part of core user journeys.",
        priority: "high",
        targetScreens: ["Details"],
        estimatedCoverageImprovement: 50,
      },
      {
        title: "Test Critical User Journeys",
        description:
          "Test 1 common navigation path(s) between screens. These transitions are frequently used but not covered by tests.",
        priority: "high",
        targetScreens: ["Search", "Details"],
        estimatedCoverageImprovement: 50,
      },
    ]);
  });

  test("uses shortest depth from multiple entry points", async () => {
    const nodes = [
      node(1, "PrimaryHome", 10),
      node(2, "SecondaryHome", 5),
      node(3, "Intermediate", 4),
      node(4, "Target", 8),
    ];
    const edges = [
      edge(10, "PrimaryHome", "Intermediate"),
      edge(11, "Intermediate", "Target"),
      edge(12, "SecondaryHome", "Target"),
    ];
    const analysis = {
      totalNodes: nodes.length,
      coveredNodes: 3,
      uncoveredNodes: [nodes[3]],
      totalEdges: edges.length,
      coveredEdges: 3,
      uncoveredEdges: [],
      coveragePercentage: 85,
    };
    const { analyzer } = analyzerFor(analysis, nodes, edges);

    const report = await analyzer.generateReport("com.example.app");

    expect(report.criticalGaps[0].screenName).toBe("Target");
    expect(report.criticalGaps[0].criticalityScore).toBe(90);
    expect(report.criticalGaps[0].recommendation).toContain("shallow in navigation tree");
  });

  test("keeps depth fallbacks for cyclic and unreachable graphs", async () => {
    const nodes = [
      node(1, "CycleA", 10),
      node(2, "CycleB", 8),
      node(3, "Entry", 3),
      node(4, "Unreachable", 4),
    ];
    const edges = [
      edge(10, "CycleA", "CycleB"),
      edge(11, "CycleB", "CycleA"),
      edge(12, "Entry", "Other"),
    ];
    const analysis = {
      totalNodes: nodes.length,
      coveredNodes: 2,
      uncoveredNodes: [nodes[0], nodes[3]],
      totalEdges: edges.length,
      coveredEdges: 3,
      uncoveredEdges: [],
      coveragePercentage: 70,
    };
    const { analyzer } = analyzerFor(analysis, nodes, edges);

    const report = await analyzer.generateReport("com.example.app");

    const cycleGap = report.criticalGaps.find((gap) => gap.screenName === "CycleA");
    const unreachableGap = report.criticalGaps.find((gap) => gap.screenName === "Unreachable");
    expect(cycleGap?.criticalityScore).toBeCloseTo(50.505, 3);
    expect(cycleGap?.recommendation).toContain("deep in navigation tree");
    expect(unreachableGap?.criticalityScore).toBeCloseTo(20.505, 3);
    expect(unreachableGap?.recommendation).toContain("deep in navigation tree");

    const noEntryAnalysis = {
      ...analysis,
      uncoveredNodes: [nodes[0]],
      uncoveredEdges: [],
    };
    const { analyzer: noEntryAnalyzer } = analyzerFor(
      noEntryAnalysis,
      nodes.slice(0, 2),
      edges.slice(0, 2),
    );

    const noEntryReport = await noEntryAnalyzer.generateReport("com.example.app");

    expect(noEntryReport.criticalGaps[0].criticalityScore).toBe(100);
    expect(noEntryReport.criticalGaps[0].recommendation).toContain("shallow in navigation tree");
  });
});
