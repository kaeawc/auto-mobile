import type { NavigationEdgeTarget } from "../../db/navigationRepository";
import type { TestCoverageSession } from "../../db/types";
import type { BackStackInfo } from "../../models";

/** The part of a back-stack capture the graph records: its depth and current task. */
export type RecordedBackStack = Pick<BackStackInfo, "depth" | "currentTaskId">;
import type {
  ExportedGraph,
  HierarchyNavigationEvent,
  IncomingNavigationEvent,
  NavigationAppListProvider,
  NavigationEdge,
  NavigationGraph,
  NavigationGraphHistoryPage,
  NavigationGraphHistoryProvider,
  NavigationGraphNodeResource,
  NavigationGraphNodeResourceProvider,
  NavigationGraphStats,
  NavigationGraphSummary,
  NavigationGraphSummaryProvider,
  NavigationNode,
  NavigationSuggestionInfo,
  NavigationToolCallHandle,
  PathResult,
  ScrollPosition,
  UIState,
} from "../../utils/interfaces/NavigationGraph";

/**
 * Interface for navigation graph management operations.
 * Provides methods for tracking screen visits, recording navigation events,
 * and querying navigation paths.
 */
export interface NavigationGraphService
  extends
    NavigationGraph,
    NavigationGraphSummaryProvider,
    NavigationGraphHistoryProvider,
    NavigationGraphNodeResourceProvider,
    NavigationAppListProvider {
  // App management
  setCurrentApp(appId: string): Promise<void>;
  getCurrentAppId(): string | null;

  // Build/device provenance (#4984)
  setBuildContext(context: NavigationBuildContext): void;
  clearBuildContext(appId: string): void;
  getBuildContexts(): NavigationBuildContext[];
  setBuildContextUpdateListener(
    listener: ((change: NavigationBuildContextChange) => void) | null,
  ): void;
  getDeviceIdForApp(appId: string | null): string | null;
  recordAppForeground(appId: string, deviceId?: string): Promise<void>;
  forgetAppScreen(appId: string): void;
  forgetAllAppScreens(): void;

  // Screen tracking
  getCurrentScreen(): string | null;
  recordBackStack(backStack: RecordedBackStack): Promise<void>;

  // Navigation events
  recordNavigationEvent(event: IncomingNavigationEvent): Promise<void>;
  recordHierarchyNavigation(event: HierarchyNavigationEvent): Promise<void>;

  // Tool call correlation
  recordToolCall(
    toolName: string,
    args: Record<string, any>,
    uiState?: UIState,
    deviceId?: string,
  ): NavigationToolCallHandle;
  updateScrollPosition(scrollPosition: ScrollPosition): void;

  // Pathfinding
  findPath(targetScreen: string): Promise<PathResult>;
  recordEdgeReplayOutcome(edge: NavigationEdge, reached: boolean): void;
  hasEdgeReplayFailure(edge: NavigationEdge): boolean;
  settleTransientEdgeFailure(edge: NavigationEdge, searched: boolean): void;

  // Graph queries
  getKnownScreens(): Promise<string[]>;
  getNode(screenName: string): Promise<NavigationNode | undefined>;
  getNodeResourceById(nodeId: number, appId?: string): Promise<NavigationGraphNodeResource | null>;
  getNodeResourceByScreen(screenName: string): Promise<NavigationGraphNodeResource | null>;
  getEdgesFrom(screenName: string): Promise<NavigationEdge[]>;
  getEdgesTo(screenName: string): Promise<NavigationEdge[]>;
  getEdgeTargetsFrom(screenName: string): Promise<NavigationEdgeTarget[]>;
  getStats(): Promise<NavigationGraphStats>;
  /** Statistics for a specific app without changing the active graph. */
  getStatsForApp(appId: string | null): Promise<NavigationGraphStats>;

  // Graph operations
  clearCurrentGraph(): Promise<void>;
  clearAllGraphs(): Promise<void>;
  exportGraph(): Promise<ExportedGraph>;
  exportGraphForApp(appId: string | null): Promise<ExportedGraph>;
  exportGraphSummary(): Promise<NavigationGraphSummary>;
  exportGraphSummaryForApp(appId: string | null): Promise<NavigationGraphSummary>;
  exportGraphHistory(options?: {
    cursor?: string;
    limit?: number;
  }): Promise<NavigationGraphHistoryPage>;

  // Screenshot management
  updateNodeScreenshot(
    appId: string,
    screenName: string,
    screenshotPath: string | null,
  ): Promise<void>;

  // Suggestions
  getSuggestions(): Promise<NavigationSuggestionInfo[]>;
  promoteSuggestion(suggestionId: number, screenName: string): Promise<void>;

  // Test coverage
  startTestSession(sessionUuid: string): Promise<void>;
  endTestSession(): Promise<void>;
  getActiveTestSession(): TestCoverageSession | null;

  // Listeners
  setGraphUpdateListener(listener: (() => void | Promise<void>) | null): void;
}

/**
 * Build/device provenance context for a graph mutation (#4984). The build key is
 * (packageId=appId, versionCode, contentHash); deviceId names the device the
 * mutation was observed on. appId is carried so a context resolved for one app is
 * never applied to another when a session observes multiple apps on a device —
 * a stale context falls back to the default build key instead of mis-stamping.
 */
export interface NavigationBuildContext {
  appId: string;
  deviceId: string;
  versionCode: number;
  /** Non-integer platform version, retained in memory/wire only; DB identity uses 0 + hash. */
  versionKey?: string;
  contentHash: string;
}

export interface NavigationBuildContextChange {
  appId: string;
  deviceId: string;
  buildContext: NavigationBuildContext | null;
}
