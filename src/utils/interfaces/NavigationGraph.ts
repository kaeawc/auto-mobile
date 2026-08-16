/**
 * Represents a navigation event received from the Android SDK.
 */
export interface NavigationEvent {
  destination: string;
  source: string;
  arguments: Record<string, string>;
  metadata: Record<string, string>;
  timestamp: number; // milliseconds
  sequenceNumber: number;
  /** The application package ID (e.g., "com.example.app") */
  applicationId?: string;
  /** The interaction that triggered this navigation (set by CtrlProxyClient) */
  triggeringInteraction?: { type: string; elementText?: string; elementResourceId?: string } | null;
}

/**
 * Represents a modal state (bottom sheet, dialog, popup, etc.) in the UI hierarchy.
 */
export interface ModalState {
  /** Type of modal (bottomsheet, dialog, popup, menu) */
  type: "bottomsheet" | "dialog" | "popup" | "menu" | "overlay";
  /** Unique identifier (resource-id preferred, falls back to text content) */
  identifier?: string;
  /** Stack depth (0 = base screen, higher = on top) */
  layer: number;
  /** Window ID from accessibility service */
  windowId?: number;
  /** Window type from accessibility service */
  windowType?: string;
}

/**
 * Represents a selected UI element (tab, menu item, etc.) captured at the time of a tool call.
 */
export interface SelectedElementDetection {
  method: "accessibility" | "visual";
  confidence: number;
  reason?: string;
}

export interface SelectedElement {
  text?: string;
  resourceId?: string;
  contentDesc?: string;
  selectedState?: SelectedElementDetection;
}

/**
 * Represents scroll position needed to make a navigation element visible.
 */
export interface ScrollPosition {
  /** The scrollable container that was scrolled */
  container?: {
    text?: string;
    resourceId?: string;
    contentDesc?: string;
  };
  /** The target element that was scrolled to */
  targetElement: {
    text?: string;
    resourceId?: string;
    contentDesc?: string;
  };
  /** Direction that was scrolled */
  direction: "up" | "down" | "left" | "right";
  /** Speed used for scrolling */
  speed?: "slow" | "normal" | "fast";
}

/**
 * Represents the UI state at the time of a tool call.
 * Captures context needed to replay navigation (e.g., which tab is active).
 */
export interface UIState {
  /** Currently selected elements (tabs, menu items, etc.) */
  selectedElements: SelectedElement[];
  /** The destination/screen name if available from view hierarchy */
  destinationId?: string;
  /** Active modal stack (bottom sheets, dialogs, popups, etc.) */
  modalStack?: ModalState[];
  /** Scroll position required to make navigation elements visible */
  scrollPosition?: ScrollPosition;
}

/**
 * Represents a recorded tool call for correlation with navigation events.
 */
export interface ToolCallInteraction {
  toolName: string;
  args: Record<string, any>;
  timestamp: number; // milliseconds
  /** UI state at the time of the tool call */
  uiState?: UIState;
}

/**
 * Represents a screen/destination in the navigation graph.
 */
export interface NavigationNode {
  screenName: string;
  firstSeenAt: number; // milliseconds
  lastSeenAt: number; // milliseconds
  visitCount: number;
  /** Modal stack state when this node was recorded */
  modalStack?: ModalState[];
  /** Back stack depth when this node was last observed (number of screens that can be popped) */
  backStackDepth?: number;
  /** Task ID when this node was last observed */
  taskId?: number;
}

/**
 * Represents a transition between screens in the navigation graph.
 */
export interface NavigationEdge {
  from: string;
  to: string;
  interaction?: ToolCallInteraction;
  timestamp: number; // milliseconds
  edgeType: "tool" | "back" | "unknown";
  /** UI state required before executing the interaction (e.g., which tab must be active) */
  uiState?: UIState;
  /** Modal stack at the source screen */
  fromModalStack?: ModalState[];
  /** Modal stack at the destination screen */
  toModalStack?: ModalState[];
}

/**
 * Statistics about the navigation graph.
 */
export interface NavigationGraphStats {
  nodeCount: number;
  edgeCount: number;
  currentScreen: string | null;
  knownEdgeCount: number;
  unknownEdgeCount: number;
  toolCallHistorySize: number;
}

/**
 * Result of a path search in the navigation graph.
 */
export interface PathResult {
  found: boolean;
  path: NavigationEdge[];
  startScreen: string;
  targetScreen: string;
}

/**
 * Exported graph data for debugging/visualization.
 */
export interface ExportedGraph {
  appId: string | null;
  nodes: NavigationNode[];
  edges: NavigationEdge[];
  currentScreen: string | null;
}

/**
 * Build-key identity for a provenance observation (nav (app,build) Phase 2, #4985).
 * `packageId` is the application package id — the `navigation_build_keys.app_id`
 * column; the build-key dimension is (packageId, versionCode, contentHash).
 */
export interface NavigationProvenanceBuildKey {
  /** Application package id (navigation_build_keys.app_id). */
  packageId: string;
  /** APK version code the observation was recorded under (0 for legacy/default). */
  versionCode: number;
  /** Content hash of the build (empty string for legacy/default). */
  contentHash: string;
}

/**
 * A single provenance observation attached to a node or edge in the app-level
 * union graph (nav (app,build) Phase 2, #4985): which build/device/session
 * reached it and when it was last seen there. Sourced from the Phase 1 (#4984)
 * `navigation_node_observations` / `navigation_edge_observations` tables. Each
 * record is unique per (buildKey, deviceId, sessionUuid); `lastSeen` mirrors the
 * observation's `last_seen_at`. `deviceId`/`sessionUuid` are `"legacy"` for rows
 * backfilled from pre-provenance graphs.
 */
export interface NavigationProvenanceRecord {
  buildKey: NavigationProvenanceBuildKey;
  deviceId: string;
  /** Owning agent-session UUID that observed the mutation (not deviceSessionUuid). */
  sessionUuid: string;
  /** Epoch ms of the most recent observation for this (build, device, session). */
  lastSeen: number;
}

/**
 * High-level summary node for navigation graph resources.
 */
export interface NavigationGraphSummaryNode {
  id: number;
  screenName: string;
  visitCount: number;
  /** Path to screenshot file, or resource URI for fetching */
  screenshotPath?: string | null;
  /**
   * Per-(build, device, session) provenance for this node in the app-union graph
   * (#4985). Additive/optional: consumers that ignore it are unaffected. Omitted
   * when the summary is produced without a provenance source (e.g. fakes); an
   * empty array means the node has no recorded observations.
   */
  provenance?: NavigationProvenanceRecord[];
}

/**
 * High-level summary edge for navigation graph resources.
 * When aggregated, represents a unique transition (from → to via toolName) with a traversal count.
 */
export interface NavigationGraphSummaryEdge {
  id: number;
  from: string;
  to: string;
  toolName: string | null;
  /** Number of times this transition has been traversed */
  traversalCount: number;
  /**
   * Per-(build, device, session) provenance for this transition, unioned across
   * every underlying edge row aggregated into it (#4985). Additive/optional; see
   * {@link NavigationGraphSummaryNode.provenance}.
   */
  provenance?: NavigationProvenanceRecord[];
}

/**
 * High-level summary of the navigation graph for MCP resources.
 */
export interface NavigationGraphSummary {
  appId: string | null;
  nodes: NavigationGraphSummaryNode[];
  edges: NavigationGraphSummaryEdge[];
  currentScreen: string | null;
}

/**
 * Detailed navigation node representation for MCP resources.
 */
export interface NavigationGraphNodeDetail extends NavigationNode {
  id: number;
}

/**
 * Node-level navigation graph resource for MCP.
 */
export interface NavigationGraphNodeResource {
  appId: string | null;
  node: NavigationGraphNodeDetail;
  isCurrentScreen: boolean;
  edgesFrom: NavigationEdge[];
  edgesTo: NavigationEdge[];
}

/**
 * Ordered navigation edge for history playback.
 */
export interface NavigationGraphHistoryEdge {
  id: number;
  from: string;
  to: string;
  toolName: string | null;
  timestamp: number;
}

/**
 * Ordered navigation node for history playback.
 */
export interface NavigationGraphHistoryNode {
  id: number | null;
  screenName: string;
  timestamp: number;
  edgeId?: number | null;
}

/**
 * Paginated navigation history resource.
 */
export interface NavigationGraphHistoryPage {
  appId: string | null;
  currentScreen: string | null;
  cursor: string | null;
  nextCursor: string | null;
  nodes: NavigationGraphHistoryNode[];
  edges: NavigationGraphHistoryEdge[];
}

/**
 * Summary of an app that has a persisted navigation graph. Enables enumerating
 * apps for an offline picker without a connected device.
 */
export interface NavigationAppSummary {
  /** Application package id (e.g. "com.example.app"). */
  appId: string;
  /**
   * Human-readable name when known. The persisted navigation schema has no
   * display-name column, so this is currently always null; the field exists so
   * a name source can be wired without a breaking response-shape change.
   */
  displayName: string | null;
  /**
   * ISO-8601 timestamp of the app record's `navigation_apps.updated_at`. This is
   * bumped on the main navigation-recording paths but NOT by every graph mutation
   * (e.g. promoteSuggestion / updateNodeScreenshot / recordBackStack do not touch
   * it), so it can lag those changes. Do not treat it as the exact time of the
   * most recent graph mutation. Tracked by issue #4931.
   */
  lastUpdated: string;
}

/**
 * Provider that enumerates apps which have a persisted navigation graph.
 * Device-independent — reads only persisted rows.
 */
export interface NavigationAppListProvider {
  listAppsWithGraph(): Promise<NavigationAppSummary[]>;
}

/**
 * Provider interface for navigation graph summaries.
 */
export interface NavigationGraphSummaryProvider {
  exportGraphSummary(): Promise<NavigationGraphSummary>;
  exportGraphSummaryForApp?(appId: string | null): Promise<NavigationGraphSummary>;
  setGraphUpdateListener?(listener: (() => void) | null): void;
}

/**
 * Provider interface for navigation graph node resources.
 */
export interface NavigationGraphNodeResourceProvider {
  getNodeResourceById(nodeId: number): Promise<NavigationGraphNodeResource | null>;
  getNodeResourceByScreen(screenName: string): Promise<NavigationGraphNodeResource | null>;
}

/**
 * Provider interface for navigation graph history resources.
 */
export interface NavigationGraphHistoryProvider {
  exportGraphHistory(options?: {
    cursor?: string;
    limit?: number;
  }): Promise<NavigationGraphHistoryPage>;
}

/**
 * Represents back stack information
 */
export interface BackStackInfo {
  depth: number;
  currentTaskId?: number;
}

/**
 * Represents a navigation event detected from view hierarchy changes.
 * This is an alternative to SDK navigation events for apps without SDK integration.
 */
export interface HierarchyNavigationEvent {
  /** Screen fingerprint of the source screen (null if first screen) */
  fromFingerprint: string | null;
  /** Screen fingerprint of the destination screen */
  toFingerprint: string;
  /** Full fingerprint data as JSON string */
  fingerprintData?: string;
  /** Timestamp when the navigation was detected */
  timestamp: number;
  /** Package name of the app */
  packageName?: string;
}

/**
 * Represents a navigation suggestion - an uncorrelated fingerprint that
 * could potentially be mapped to a named screen.
 */
export interface NavigationSuggestionInfo {
  id: number;
  fingerprintHash: string;
  fingerprintData: string;
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
}

/**
 * Interface for navigation graph management.
 * Allows for easy mocking in tests.
 */
export interface NavigationGraph {
  /** Set the current app being navigated */
  setCurrentApp(appId: string): Promise<void>;

  /** Get the current app ID */
  getCurrentAppId(): string | null;

  /** Record a navigation event from WebSocket */
  recordNavigationEvent(event: NavigationEvent): Promise<void>;

  /** Record a navigation event detected from view hierarchy changes */
  recordHierarchyNavigation(event: HierarchyNavigationEvent): Promise<void>;

  /** Record back stack information for the current screen */
  recordBackStack(backStack: BackStackInfo): void;

  /** Record a tool call for correlation */
  recordToolCall(toolName: string, args: Record<string, any>, uiState?: UIState): void;

  /** Get the current screen name */
  getCurrentScreen(): string | null;

  /** Find the shortest path from current screen to target */
  findPath(targetScreen: string): Promise<PathResult>;

  /** Get all known screen names */
  getKnownScreens(): Promise<string[]>;

  /** Get a specific node by screen name */
  getNode(screenName: string): Promise<NavigationNode | undefined>;

  /** Get all edges from a specific screen */
  getEdgesFrom(screenName: string): Promise<NavigationEdge[]>;

  /** Get all edges to a specific screen */
  getEdgesTo(screenName: string): Promise<NavigationEdge[]>;

  /** Get graph statistics */
  getStats(): Promise<NavigationGraphStats>;

  /** Clear the graph for the current app */
  clearCurrentGraph(): Promise<void>;

  /** Clear all graphs */
  clearAllGraphs(): Promise<void>;

  /** Export the current graph for debugging */
  exportGraph(): Promise<ExportedGraph>;

  /** Get unpromoted navigation suggestions for the current app */
  getSuggestions(): Promise<NavigationSuggestionInfo[]>;

  /** Promote a suggestion to a named node */
  promoteSuggestion(suggestionId: number, screenName: string): Promise<void>;
}
