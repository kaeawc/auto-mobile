import { testCoverageRepository } from "../../db/testCoverageRepository";
import { NavigationRepository } from "../../db/navigationRepository";
import type { NavigationNode, NavigationEdge } from "../../db/types";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

interface CoverageAnalysis {
  totalNodes: number;
  coveredNodes: number;
  uncoveredNodes: NavigationNode[];
  totalEdges: number;
  coveredEdges: number;
  uncoveredEdges: NavigationEdge[];
  coveragePercentage: number;
}

interface TestCoverageAnalysisRepository {
  getAggregatedCoverageAnalysis(appId: string): Promise<CoverageAnalysis>;
}

interface NavigationGraphRepository {
  getNodes(appId: string): Promise<NavigationNode[]>;
  getEdges(appId: string): Promise<NavigationEdge[]>;
}

interface TestCoverageAnalyzerOptions {
  coverageRepository?: TestCoverageAnalysisRepository;
  navigationRepository?: NavigationGraphRepository;
  timer?: Timer;
}

interface GraphAnalysis {
  nodeByScreen: Map<string, NavigationNode>;
  inEdgesByScreen: Map<string, NavigationEdge[]>;
  outEdgesByScreen: Map<string, NavigationEdge[]>;
  depthsByScreen: Map<string, number>;
  hasEntryPoints: boolean;
}

interface CoverageGap {
  type: "node" | "edge";
  id: number;
  screenName?: string;
  fromScreen?: string;
  toScreen?: string;
  criticalityScore: number;
  recommendation: string;
}

interface TestCoverageReport {
  appId: string;
  generatedAt: number;

  // Overall metrics
  totalNodes: number;
  coveredNodes: number;
  uncoveredNodes: number;
  nodeCoveragePercent: number;

  totalEdges: number;
  coveredEdges: number;
  uncoveredEdges: number;
  edgeCoveragePercent: number;

  overallCoveragePercent: number;

  // Detailed gaps
  criticalGaps: CoverageGap[];

  // Recommendations
  recommendations: string[];

  // Suggested test scenarios
  suggestedScenarios: TestScenario[];
}

interface TestScenario {
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  targetScreens: string[];
  estimatedCoverageImprovement: number;
}

/**
 * Analyzes test coverage for navigation graphs and generates recommendations.
 *
 * @internal Exported for focused unit tests and internal dependency injection;
 * production callers should use the `testCoverageAnalyzer` singleton.
 */
export class TestCoverageAnalyzer {
  private coverageRepository: TestCoverageAnalysisRepository;
  private navigationRepository: NavigationGraphRepository;
  private timer: Timer;

  constructor(options: TestCoverageAnalyzerOptions = {}) {
    this.coverageRepository = options.coverageRepository ?? testCoverageRepository;
    this.navigationRepository = options.navigationRepository ?? new NavigationRepository();
    this.timer = options.timer ?? defaultTimer;
  }

  /**
   * Generate a comprehensive test coverage report for an app.
   */
  async generateReport(appId: string): Promise<TestCoverageReport> {
    logger.info(`[TEST_COVERAGE] Generating coverage report for app: ${appId}`);

    // Get aggregated coverage data
    const coverageData = await this.coverageRepository.getAggregatedCoverageAnalysis(appId);

    // Calculate criticality scores for uncovered elements
    const criticalGaps = await this.identifyCriticalGaps(
      appId,
      coverageData.uncoveredNodes,
      coverageData.uncoveredEdges,
    );

    // Generate recommendations
    const recommendations = this.generateRecommendations(coverageData, criticalGaps);

    // Generate suggested test scenarios
    const suggestedScenarios = await this.generateTestScenarios(appId, criticalGaps);

    const nodeCoveragePercent =
      coverageData.totalNodes > 0 ? (coverageData.coveredNodes / coverageData.totalNodes) * 100 : 0;

    const edgeCoveragePercent =
      coverageData.totalEdges > 0 ? (coverageData.coveredEdges / coverageData.totalEdges) * 100 : 0;

    const report: TestCoverageReport = {
      appId,
      generatedAt: this.timer.now(),
      totalNodes: coverageData.totalNodes,
      coveredNodes: coverageData.coveredNodes,
      uncoveredNodes: coverageData.uncoveredNodes.length,
      nodeCoveragePercent,
      totalEdges: coverageData.totalEdges,
      coveredEdges: coverageData.coveredEdges,
      uncoveredEdges: coverageData.uncoveredEdges.length,
      edgeCoveragePercent,
      overallCoveragePercent: coverageData.coveragePercentage,
      criticalGaps,
      recommendations,
      suggestedScenarios,
    };

    logger.info(
      `[TEST_COVERAGE] Report generated: ${report.overallCoveragePercent.toFixed(1)}% overall coverage, ` +
        `${report.criticalGaps.length} critical gaps identified`,
    );

    return report;
  }

  /**
   * Identify critical coverage gaps based on edge frequency and depth.
   * Higher frequency and shallower depth = more critical.
   */
  private async identifyCriticalGaps(
    appId: string,
    uncoveredNodes: NavigationNode[],
    uncoveredEdges: NavigationEdge[],
  ): Promise<CoverageGap[]> {
    const gaps: CoverageGap[] = [];

    // Get all nodes and edges for frequency/depth analysis
    const allNodes = await this.navigationRepository.getNodes(appId);
    const allEdges = await this.navigationRepository.getEdges(appId);
    const graphAnalysis = this.buildGraphAnalysis(allNodes, allEdges);

    // Calculate max values for normalization
    const maxVisits = Math.max(...allNodes.map((n) => n.visit_count), 1);

    // Analyze uncovered nodes
    for (const node of uncoveredNodes) {
      const inEdges = graphAnalysis.inEdgesByScreen.get(node.screen_name) ?? [];
      const outEdges = graphAnalysis.outEdgesByScreen.get(node.screen_name) ?? [];
      const edgeCount = inEdges.length + outEdges.length;

      // Calculate depth (minimum hops from entry point)
      const depth = this.getNodeDepth(node.screen_name, graphAnalysis);

      // Criticality score: high frequency + shallow depth = high criticality
      // Frequency score: 0-50 based on visit count
      // Depth score: 0-50 based on inverse of depth (shallower = higher score)
      const frequencyScore = (node.visit_count / maxVisits) * 50;
      const depthScore = depth > 0 ? (1 / depth) * 50 : 25;
      const criticalityScore = frequencyScore + depthScore;

      gaps.push({
        type: "node",
        id: node.id,
        screenName: node.screen_name,
        criticalityScore,
        recommendation: this.generateNodeRecommendation(node, depth, edgeCount),
      });
    }

    // Analyze uncovered edges
    for (const edge of uncoveredEdges) {
      // Get frequency data for connected nodes
      const fromNode = graphAnalysis.nodeByScreen.get(edge.from_screen);
      const toNode = graphAnalysis.nodeByScreen.get(edge.to_screen);

      if (!fromNode || !toNode) {
        continue;
      }

      // Calculate depth of source node
      const depth = this.getNodeDepth(edge.from_screen, graphAnalysis);

      // Edge criticality based on node visit counts and depth
      const avgVisits = (fromNode.visit_count + toNode.visit_count) / 2;
      const frequencyScore = (avgVisits / maxVisits) * 50;
      const depthScore = depth > 0 ? (1 / depth) * 50 : 25;
      const criticalityScore = frequencyScore + depthScore;

      gaps.push({
        type: "edge",
        id: edge.id,
        fromScreen: edge.from_screen,
        toScreen: edge.to_screen,
        criticalityScore,
        recommendation: this.generateEdgeRecommendation(edge, depth),
      });
    }

    // Sort by criticality score (descending)
    gaps.sort((a, b) => b.criticalityScore - a.criticalityScore);

    return gaps;
  }

  /**
   * Build graph indexes once per report so each coverage gap can be scored with
   * constant-time lookups.
   */
  private buildGraphAnalysis(
    allNodes: NavigationNode[],
    allEdges: NavigationEdge[],
  ): GraphAnalysis {
    const nodeByScreen = new Map<string, NavigationNode>();
    const inEdgesByScreen = new Map<string, NavigationEdge[]>();
    const outEdgesByScreen = new Map<string, NavigationEdge[]>();
    const allScreens = new Set<string>();
    const incomingCounts = new Map<string, number>();

    for (const node of allNodes) {
      nodeByScreen.set(node.screen_name, node);
    }

    for (const edge of allEdges) {
      allScreens.add(edge.from_screen);
      allScreens.add(edge.to_screen);
      incomingCounts.set(edge.to_screen, (incomingCounts.get(edge.to_screen) ?? 0) + 1);

      const outEdges = outEdgesByScreen.get(edge.from_screen) ?? [];
      outEdges.push(edge);
      outEdgesByScreen.set(edge.from_screen, outEdges);

      const inEdges = inEdgesByScreen.get(edge.to_screen) ?? [];
      inEdges.push(edge);
      inEdgesByScreen.set(edge.to_screen, inEdges);
    }

    const entryPoints: string[] = [];
    for (const screen of allScreens) {
      if ((incomingCounts.get(screen) ?? 0) === 0) {
        entryPoints.push(screen);
      }
    }

    return {
      nodeByScreen,
      inEdgesByScreen,
      outEdgesByScreen,
      depthsByScreen: this.calculateDepthsFromEntryPoints(entryPoints, outEdgesByScreen),
      hasEntryPoints: entryPoints.length > 0,
    };
  }

  private calculateDepthsFromEntryPoints(
    entryPoints: string[],
    outEdgesByScreen: Map<string, NavigationEdge[]>,
  ): Map<string, number> {
    const depthsByScreen = new Map<string, number>();
    const queue: Array<{ screen: string; depth: number }> = [];

    for (const entryPoint of entryPoints) {
      depthsByScreen.set(entryPoint, 0);
      queue.push({ screen: entryPoint, depth: 0 });
    }

    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const { screen, depth } = queue[queueIndex++];
      const outgoing = outEdgesByScreen.get(screen) ?? [];

      for (const edge of outgoing) {
        if (!depthsByScreen.has(edge.to_screen)) {
          const nextDepth = depth + 1;
          depthsByScreen.set(edge.to_screen, nextDepth);
          queue.push({ screen: edge.to_screen, depth: nextDepth });
        }
      }
    }

    return depthsByScreen;
  }

  private getNodeDepth(screenName: string, graphAnalysis: GraphAnalysis): number {
    if (!graphAnalysis.hasEntryPoints) {
      // No clear entry point, preserve the previous depth fallback.
      return 1;
    }

    return graphAnalysis.depthsByScreen.get(screenName) ?? 99;
  }

  /**
   * Generate recommendation text for an uncovered node.
   */
  private generateNodeRecommendation(
    node: NavigationNode,
    depth: number,
    edgeCount: number,
  ): string {
    const visitText = node.visit_count > 1 ? `${node.visit_count} visits` : "1 visit";
    const depthText = depth <= 2 ? "shallow" : depth <= 4 ? "medium" : "deep";

    return `Screen "${node.screen_name}" (${visitText}, ${depthText} in navigation tree, ${edgeCount} connections) has not been tested. Add test coverage to verify functionality.`;
  }

  /**
   * Generate recommendation text for an uncovered edge.
   */
  private generateEdgeRecommendation(edge: NavigationEdge, depth: number): string {
    const depthText = depth <= 2 ? "shallow" : depth <= 4 ? "medium" : "deep";
    const toolText = edge.tool_name ? ` via ${edge.tool_name}` : "";

    return `Transition from "${edge.from_screen}" to "${edge.to_screen}"${toolText} (${depthText} in navigation tree) has not been tested. Add test coverage for this user journey.`;
  }

  /**
   * Generate high-level recommendations based on coverage data.
   */
  private generateRecommendations(coverageData: any, criticalGaps: CoverageGap[]): string[] {
    const recommendations: string[] = [];

    // Overall coverage recommendation
    if (coverageData.coveragePercentage < 50) {
      recommendations.push(
        `Overall coverage is ${coverageData.coveragePercentage.toFixed(1)}% - significantly increase test coverage across the application.`,
      );
    } else if (coverageData.coveragePercentage < 80) {
      recommendations.push(
        `Overall coverage is ${coverageData.coveragePercentage.toFixed(1)}% - add tests for critical user journeys to reach 80%+ coverage.`,
      );
    } else {
      recommendations.push(
        `Overall coverage is ${coverageData.coveragePercentage.toFixed(1)}% - focus on edge cases and less common user flows.`,
      );
    }

    // Node vs edge coverage
    const nodeCoverage =
      coverageData.totalNodes > 0 ? (coverageData.coveredNodes / coverageData.totalNodes) * 100 : 0;
    const edgeCoverage =
      coverageData.totalEdges > 0 ? (coverageData.coveredEdges / coverageData.totalEdges) * 100 : 0;

    if (nodeCoverage - edgeCoverage > 20) {
      recommendations.push(
        `Node coverage (${nodeCoverage.toFixed(1)}%) is significantly higher than edge coverage (${edgeCoverage.toFixed(1)}%). Focus on testing transitions and user journeys between screens.`,
      );
    } else if (edgeCoverage - nodeCoverage > 20) {
      recommendations.push(
        `Edge coverage (${edgeCoverage.toFixed(1)}%) is higher than node coverage (${nodeCoverage.toFixed(1)}%). Ensure all screens are visited during tests.`,
      );
    }

    // Critical gaps
    const highCriticalityGaps = criticalGaps.filter((g) => g.criticalityScore > 60);
    if (highCriticalityGaps.length > 0) {
      recommendations.push(
        `${highCriticalityGaps.length} high-priority coverage gap(s) identified in frequently-used, shallow screens. Prioritize testing these areas.`,
      );
    }

    // Uncovered screens
    if (coverageData.uncoveredNodes.length > 0) {
      const topUncovered = coverageData.uncoveredNodes
        .slice(0, 3)
        .map((n: NavigationNode) => n.screen_name)
        .join(", ");
      recommendations.push(
        `${coverageData.uncoveredNodes.length} screen(s) have no test coverage. Top uncovered: ${topUncovered}`,
      );
    }

    return recommendations;
  }

  /**
   * Generate suggested test scenarios based on coverage gaps.
   */
  private async generateTestScenarios(
    appId: string,
    criticalGaps: CoverageGap[],
  ): Promise<TestScenario[]> {
    const scenarios: TestScenario[] = [];

    // Group gaps by criticality
    const highPriority = criticalGaps.filter((g) => g.criticalityScore > 60);
    const mediumPriority = criticalGaps.filter(
      (g) => g.criticalityScore > 30 && g.criticalityScore <= 60,
    );

    // Generate scenarios for high-priority gaps
    if (highPriority.length > 0) {
      const nodeGaps = highPriority.filter((g) => g.type === "node");
      const edgeGaps = highPriority.filter((g) => g.type === "edge");

      if (nodeGaps.length > 0) {
        scenarios.push({
          title: "Cover Critical Screens",
          description: `Test ${nodeGaps.length} frequently-accessed screen(s) that currently have no coverage. These are shallow in the navigation tree and likely part of core user journeys.`,
          priority: "high",
          targetScreens: nodeGaps.map((g) => g.screenName!),
          estimatedCoverageImprovement: (nodeGaps.length / (criticalGaps.length || 1)) * 100,
        });
      }

      if (edgeGaps.length > 0) {
        const uniqueScreens = new Set<string>();
        edgeGaps.forEach((g) => {
          if (g.fromScreen) {
            uniqueScreens.add(g.fromScreen);
          }
          if (g.toScreen) {
            uniqueScreens.add(g.toScreen);
          }
        });

        scenarios.push({
          title: "Test Critical User Journeys",
          description: `Test ${edgeGaps.length} common navigation path(s) between screens. These transitions are frequently used but not covered by tests.`,
          priority: "high",
          targetScreens: Array.from(uniqueScreens),
          estimatedCoverageImprovement: (edgeGaps.length / (criticalGaps.length || 1)) * 100,
        });
      }
    }

    // Generate scenarios for medium-priority gaps
    if (mediumPriority.length > 0 && scenarios.length < 3) {
      const nodeGaps = mediumPriority.filter((g) => g.type === "node");

      if (nodeGaps.length > 0) {
        scenarios.push({
          title: "Expand Screen Coverage",
          description: `Add tests for ${nodeGaps.length} additional screen(s) to improve overall coverage. These are moderately important screens in the navigation flow.`,
          priority: "medium",
          targetScreens: nodeGaps.slice(0, 5).map((g) => g.screenName!),
          estimatedCoverageImprovement: (nodeGaps.length / (criticalGaps.length || 1)) * 100,
        });
      }
    }

    return scenarios.slice(0, 5); // Limit to top 5 scenarios
  }
}

// Export singleton instance
export const testCoverageAnalyzer = new TestCoverageAnalyzer();
