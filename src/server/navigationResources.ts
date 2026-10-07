import {
  ResourceRegistry,
  ResourceContent,
  ResourceReadContext,
  getRequestedResourceUri,
} from "./resourceRegistry";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import {
  diffGraphSummaryByBuild,
  filterGraphSummaryByBuild,
} from "../features/navigation/NavigationBuildLens";
import { NavigationScreenshotManager } from "../features/navigation/NavigationScreenshotManager";
import { testCoverageAnalyzer } from "../features/navigation/TestCoverageAnalyzer";
import {
  NavigationGraph,
  NavigationGraphSummary,
  NavigationGraphSummaryProvider,
  NavigationGraphNodeResource,
  NavigationGraphNodeResourceProvider,
  NavigationGraphHistoryProvider,
  NavigationAppSummary,
  NavigationAppListProvider,
  NavigationBuildFilterSummary,
  NavigationBuildDiffSummary,
  NavigationProvenanceBuildKey,
} from "../utils/interfaces/NavigationGraph";
import { logger } from "../utils/logger";
import { buildNavigationNodeScreenshotUri } from "../utils/navigationResourceUri";
import { defaultTimer } from "../utils/SystemTimer";
import { DaemonState } from "../daemon/daemonState";
import { encodeUriSegment } from "../utils/encodeUriSegment";

export const NAVIGATION_RESOURCE_URIS = {
  APPS: "automobile:navigation/apps",
  GRAPH: "automobile:navigation/graph",
  GRAPH_WITH_APP_ID: "automobile:navigation/graph?appId={appId}",
  GRAPH_BUILD_FILTER:
    "automobile:navigation/graph/build-filter?appId={appId}&versionCode={versionCode}&contentHash={contentHash}",
  GRAPH_BUILD_DIFF:
    "automobile:navigation/graph/build-diff?appId={appId}&versionCodeA={versionCodeA}&contentHashA={contentHashA}&versionCodeB={versionCodeB}&contentHashB={contentHashB}",
  NODE_BY_ID: "automobile:navigation/nodes/{nodeId}",
  NODE_BY_ID_WITH_APP_ID: "automobile:navigation/nodes/{nodeId}?appId={appId}",
  NODE_BY_SCREEN: "automobile:navigation/nodes?screen={screenName}",
  NODE_SCREENSHOT: "automobile:navigation/nodes/{nodeId}/screenshot",
  NODE_SCREENSHOT_WITH_APP_ID: "automobile:navigation/nodes/{nodeId}/screenshot?appId={appId}",
  HISTORY: "automobile:navigation/history",
  HISTORY_WITH_CURSOR: "automobile:navigation/history?cursor={cursor}",
  HISTORY_WITH_LIMIT: "automobile:navigation/history?limit={limit}",
  HISTORY_WITH_CURSOR_AND_LIMIT: "automobile:navigation/history?cursor={cursor}&limit={limit}",
  TEST_COVERAGE: "automobile:navigation/test-coverage",
} as const;

export type NavigationGraphResourceContent = NavigationGraphSummary;
export type NavigationNodeResourceContent = NavigationGraphNodeResource;
export type NavigationBuildFilterResourceContent = NavigationBuildFilterSummary;
export type NavigationBuildDiffResourceContent = NavigationBuildDiffSummary;
/**
 * Payload of the `automobile:navigation/apps` resource: apps that have a
 * persisted navigation graph. Each entry's `lastUpdated` reflects the app
 * record's `navigation_apps.updated_at`, which can lag graph mutations that do
 * not touch the parent timestamp (issue #4931); it is not the exact time of the
 * most recent graph change.
 */
export interface NavigationAppsResourceContent {
  apps: NavigationAppSummary[];
}

const GRAPH_RESOURCE_UPDATE_DEBOUNCE_MS = 1000;

// Decode a query param captured by these navigation templates (`appId`,
// `screenName`, `cursor`, `limit`). The registry compiles the literal `?name=`
// form to a RAW regex group (it only URL-decodes params for RFC-6570 `{?name}`
// templates like storageCapabilities), so this single decodeURIComponent is the
// first-and-only decode — NOT the #5686 double-decode, and it must stay. Guard it
// so a malformed percent-sequence (a bad-client `%`) falls back to the raw value
// instead of throwing an uncaught URIError past each handler's try/catch and
// bypassing the JSON error envelope — matching #5686's graceful handling of the
// same input (#5748 for `{?appId}`; #5853 extended it to the sibling params).
function decodeUriParam(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw).trim();
  } catch (error) {
    // Malformed percent-encoding is bad client input, not a server fault: return
    // the raw value so the handler emits its own JSON error envelope (unresolvable
    // app / screen / cursor / limit) rather than throwing. Safe to swallow after
    // tracing.
    logger.debug(`[NavigationResources] param decode failed for '${raw}': ${error}`);
    return raw.trim();
  }
}

type NavigationGraphResourceProvider = NavigationGraphSummaryProvider &
  NavigationGraphNodeResourceProvider &
  NavigationGraphHistoryProvider &
  NavigationAppListProvider &
  Pick<NavigationGraph, "getCurrentAppId">;

let navigationGraphProvider: NavigationGraphResourceProvider | null = null;

function getActiveNavigationSessions() {
  const daemonState = DaemonState.getInstance();
  return daemonState.isInitialized() ? daemonState.getSessionManager().getAllSessions() : [];
}

function resolveUnscopedNavigationGraphManager(
  context?: ResourceReadContext,
  requireCurrentApp = true,
): NavigationGraphResourceProvider {
  if (requireCurrentApp && context?.sessionUuid) {
    return NavigationGraphManager.getInstanceForSession(context.sessionUuid);
  }
  const sessions = getActiveNavigationSessions();
  if (requireCurrentApp && sessions.length > 1) {
    throw new Error(
      "Multiple device sessions are active. Read from a session-bound connection or use an app-scoped ?appId= URI where supported.",
    );
  }
  if (sessions.length === 1) {
    return NavigationGraphManager.getInstanceForSession(sessions[0]!.sessionId);
  }
  return NavigationGraphManager.getInstance();
}

function getNavigationGraphProvider(
  context?: ResourceReadContext,
  requireCurrentApp = true,
): NavigationGraphResourceProvider {
  return (
    navigationGraphProvider ?? resolveUnscopedNavigationGraphManager(context, requireCurrentApp)
  );
}
let updateListenerProvider: NavigationGraphSummaryProvider | null = null;
// Debounce independently: an update on B must neither suppress nor broadcast A's update.
const updateTimeouts = new Map<string | undefined, ReturnType<typeof setTimeout>>();

function scheduleNavigationGraphUpdate(sessionUuid?: string): void {
  if (updateTimeouts.has(sessionUuid)) {
    return;
  }

  updateTimeouts.set(
    sessionUuid,
    defaultTimer.setTimeout(() => {
      updateTimeouts.delete(sessionUuid);
      const sessions = sessionUuid ? getActiveNavigationSessions() : [];
      // Match unbound reads at delivery time, after the debounce has elapsed.
      const unboundSessionUuid = sessions.length === 1 ? sessions[0]!.sessionId : undefined;
      void ResourceRegistry.notifyResourcesUpdated(
        [
          NAVIGATION_RESOURCE_URIS.APPS,
          NAVIGATION_RESOURCE_URIS.GRAPH,
          NAVIGATION_RESOURCE_URIS.HISTORY,
        ],
        sessionUuid,
        unboundSessionUuid,
      ).catch((error) => {
        logger.warn("[NavigationResources] Failed to notify navigation updates", error);
      });
    }, GRAPH_RESOURCE_UPDATE_DEBOUNCE_MS),
  );
}

function attachGraphUpdateListener(provider: NavigationGraphSummaryProvider): void {
  // Detach only OUR callback from the previous provider. `setGraphUpdateListener(null)`
  // removes every listener on the provider — on the global NavigationGraphManager that
  // also wiped the daemon's stream-push listener, so live graph changes stopped emitting
  // `navigation_update` frames and stream-driven clients (the desktop Navigation pane)
  // never saw the device navigate. Fall back to clear-all only for legacy providers that
  // predate removeGraphUpdateListener (their listener list is exclusively ours).
  const previous = updateListenerProvider;
  if (previous !== provider) {
    const pendingGlobalUpdate = updateTimeouts.get(undefined);
    if (pendingGlobalUpdate !== undefined) {
      defaultTimer.clearTimeout(pendingGlobalUpdate);
      updateTimeouts.delete(undefined);
    }
  }
  if (previous?.removeGraphUpdateListener) {
    previous.removeGraphUpdateListener(scheduleNavigationGraphUpdate);
  } else if (previous?.setGraphUpdateListener) {
    previous.setGraphUpdateListener(null);
  }

  updateListenerProvider = provider;

  if (provider.setGraphUpdateListener) {
    provider.setGraphUpdateListener(scheduleNavigationGraphUpdate);
  }
}

export function setNavigationGraphProvider(provider: NavigationGraphResourceProvider | null): void {
  navigationGraphProvider = provider;
  attachGraphUpdateListener(navigationGraphProvider ?? NavigationGraphManager.getInstance());
}

// Narrow seam over the screenshot manager: only what the screenshot resource
// needs (resolve + read a screenshot file), so tests can scope screenshots per
// app without touching the real file-backed singleton (#4933).
interface NavigationScreenshotResourceProvider {
  findExistingScreenshot(appId: string, screenName: string): Promise<string | null>;
  readScreenshot(screenshotPath: string): Promise<Buffer | null>;
}

let navigationScreenshotProvider: NavigationScreenshotResourceProvider | null = null;

function getNavigationScreenshotProvider(): NavigationScreenshotResourceProvider {
  return navigationScreenshotProvider ?? NavigationScreenshotManager.getInstance();
}

export function setNavigationScreenshotProvider(
  provider: NavigationScreenshotResourceProvider | null,
): void {
  navigationScreenshotProvider = provider;
}

async function getNavigationGraphResource(
  appId?: string,
  context?: ResourceReadContext,
): Promise<ResourceContent> {
  const uri = appId
    ? `automobile:navigation/graph?appId=${encodeUriSegment(appId)}`
    : NAVIGATION_RESOURCE_URIS.GRAPH;

  try {
    // Use exportGraphSummaryForApp if available and appId is provided
    let graph;
    const provider = getNavigationGraphProvider(context, !appId);
    if (appId && provider.exportGraphSummaryForApp) {
      graph = await provider.exportGraphSummaryForApp(appId);
    } else {
      graph = await provider.exportGraphSummary();
    }

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(graph, null, 2),
    };
  } catch (error) {
    logger.error(`[NavigationResources] Failed to get navigation graph: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to retrieve navigation graph: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

function parseBuildVersionCode(raw: string | undefined, name: string): number {
  const versionCode = Number(decodeUriParam(raw));
  if (!Number.isFinite(versionCode)) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return versionCode;
}

function buildNavigationBuildError(uri: string, error: string): ResourceContent {
  return { uri, mimeType: "application/json", text: JSON.stringify({ error }, null, 2) };
}

async function getNavigationBuildFilterResource(
  params: Record<string, string>,
): Promise<ResourceContent> {
  const uri = getRequestedResourceUri(params) ?? NAVIGATION_RESOURCE_URIS.GRAPH_BUILD_FILTER;
  try {
    const appId = decodeUriParam(params.appId);
    if (!appId) {
      throw new Error("App ID is required.");
    }
    const buildKey: NavigationProvenanceBuildKey = {
      packageId: appId,
      versionCode: parseBuildVersionCode(params.versionCode, "versionCode"),
      contentHash: decodeUriParam(params.contentHash) ?? "",
    };
    const provider = getNavigationGraphProvider(undefined, false);
    const summary = await (provider.exportGraphSummaryForApp?.(appId) ??
      provider.exportGraphSummary());
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(filterGraphSummaryByBuild(summary, buildKey), null, 2),
    };
  } catch (error) {
    logger.error(`[NavigationResources] Failed to get build-filtered navigation graph: ${error}`);
    return buildNavigationBuildError(
      uri,
      `Failed to retrieve build-filtered navigation graph: ${error}`,
    );
  }
}

async function getNavigationBuildDiffResource(
  params: Record<string, string>,
): Promise<ResourceContent> {
  const uri = getRequestedResourceUri(params) ?? NAVIGATION_RESOURCE_URIS.GRAPH_BUILD_DIFF;
  try {
    const appId = decodeUriParam(params.appId);
    if (!appId) {
      throw new Error("App ID is required.");
    }
    const buildA: NavigationProvenanceBuildKey = {
      packageId: appId,
      versionCode: parseBuildVersionCode(params.versionCodeA, "versionCodeA"),
      contentHash: decodeUriParam(params.contentHashA) ?? "",
    };
    const buildB: NavigationProvenanceBuildKey = {
      packageId: appId,
      versionCode: parseBuildVersionCode(params.versionCodeB, "versionCodeB"),
      contentHash: decodeUriParam(params.contentHashB) ?? "",
    };
    const provider = getNavigationGraphProvider(undefined, false);
    const summary = await (provider.exportGraphSummaryForApp?.(appId) ??
      provider.exportGraphSummary());
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(diffGraphSummaryByBuild(summary, buildA, buildB), null, 2),
    };
  } catch (error) {
    logger.error(`[NavigationResources] Failed to get build diff navigation graph: ${error}`);
    return buildNavigationBuildError(
      uri,
      `Failed to retrieve build diff navigation graph: ${error}`,
    );
  }
}

async function getNavigationAppsResource(): Promise<ResourceContent> {
  const uri = NAVIGATION_RESOURCE_URIS.APPS;

  try {
    const apps = await getNavigationGraphProvider(undefined, false).listAppsWithGraph();
    const payload: NavigationAppsResourceContent = { apps };
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(payload, null, 2),
    };
  } catch (error) {
    logger.error(`[NavigationResources] Failed to list apps with navigation graph: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to list apps with navigation graph: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

async function getNavigationGraphHistoryResource(
  uri: string,
  options: {
    cursor?: string;
    limit?: number;
  } = {},
  context?: ResourceReadContext,
): Promise<ResourceContent> {
  try {
    const history = await getNavigationGraphProvider(context).exportGraphHistory(options);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(history, null, 2),
    };
  } catch (error) {
    logger.error(`[NavigationResources] Failed to get navigation history: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to retrieve navigation history: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

function buildNavigationNodeError(uri: string, error: string): ResourceContent {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify({ error }, null, 2),
  };
}

async function getNavigationNodeByIdResource(
  nodeId: number,
  appId?: string,
  context?: ResourceReadContext,
): Promise<ResourceContent> {
  const uri = appId
    ? `automobile:navigation/nodes/${nodeId}?appId=${encodeUriSegment(appId)}`
    : `automobile:navigation/nodes/${nodeId}`;

  try {
    const nodeResource = await getNavigationGraphProvider(context, !appId).getNodeResourceById(
      nodeId,
      appId,
    );
    if (!nodeResource) {
      return buildNavigationNodeError(uri, `Navigation node ${nodeId} not found.`);
    }

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(nodeResource, null, 2),
    };
  } catch (error) {
    logger.error(`[NavigationResources] Failed to get navigation node ${nodeId}: ${error}`);
    return buildNavigationNodeError(uri, `Failed to retrieve navigation node ${nodeId}: ${error}`);
  }
}

async function getNavigationNodeByScreenResource(
  screenName: string,
  context?: ResourceReadContext,
): Promise<ResourceContent> {
  const uri = `automobile:navigation/nodes?screen=${encodeUriSegment(screenName)}`;

  try {
    const nodeResource =
      await getNavigationGraphProvider(context).getNodeResourceByScreen(screenName);
    if (!nodeResource) {
      return buildNavigationNodeError(uri, `Navigation node for screen '${screenName}' not found.`);
    }

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(nodeResource, null, 2),
    };
  } catch (error) {
    logger.error(`[NavigationResources] Failed to get navigation node '${screenName}': ${error}`);
    return buildNavigationNodeError(
      uri,
      `Failed to retrieve navigation node '${screenName}': ${error}`,
    );
  }
}

function parseHistoryParams(params: Record<string, string>): {
  cursor?: string;
  limit?: number;
} {
  const cursorRaw = decodeUriParam(params.cursor) ?? "";
  const limitRaw = decodeUriParam(params.limit) ?? "";

  const cursor = cursorRaw || undefined;
  if (!limitRaw) {
    return { cursor };
  }

  const parsedLimit = Number(limitRaw);
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    throw new Error(`Invalid history limit: ${params.limit}`);
  }

  return {
    cursor,
    limit: Math.floor(parsedLimit),
  };
}

async function getNavigationNodeScreenshotResource(
  nodeId: number,
  appId?: string,
  context?: ResourceReadContext,
): Promise<ResourceContent> {
  const uri = buildNavigationNodeScreenshotUri(nodeId, appId);

  try {
    // Resolve the screenshot under the requested app, not the daemon's current
    // foreground app: browsing a persisted app B while A (or none) is foregrounded
    // must not return A's colliding screen or an empty result (#4933). An explicit
    // appId short-circuits the current-app read, so offline browse never touches
    // the foreground singleton.
    const provider = getNavigationGraphProvider(context, !appId);
    const resolvedAppId = appId ?? provider.getCurrentAppId();
    if (!resolvedAppId) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: "No current app set." }, null, 2),
      };
    }

    // Get the node (scoped to the resolved app) to find its screen name.
    const nodeResource = await provider.getNodeResourceById(nodeId, resolvedAppId);
    if (!nodeResource || !nodeResource.node) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `Navigation node ${nodeId} not found.` }, null, 2),
      };
    }

    // Find screenshot for this screen using the screenshot manager
    const screenshotManager = getNavigationScreenshotProvider();
    const screenshotPath = await screenshotManager.findExistingScreenshot(
      resolvedAppId,
      nodeResource.node.screenName,
    );

    if (!screenshotPath) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `No screenshot available for node ${nodeId}.` }, null, 2),
      };
    }

    // Read the screenshot file
    const screenshotData = await screenshotManager.readScreenshot(screenshotPath);
    if (!screenshotData) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `Screenshot file not found for node ${nodeId}.` }, null, 2),
      };
    }

    // Return as base64-encoded blob
    return {
      uri,
      mimeType: "image/webp",
      blob: screenshotData.toString("base64"),
    };
  } catch (error) {
    logger.error(`[NavigationResources] Failed to get screenshot for node ${nodeId}: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to retrieve screenshot: ${error}` }, null, 2),
    };
  }
}

function registerNavigationGraphResources(): void {
  ResourceRegistry.register(
    NAVIGATION_RESOURCE_URIS.APPS,
    "Navigation Apps",
    "Apps that have a persisted navigation graph (appId, displayName, lastUpdated). No connected device required.",
    "application/json",
    () => getNavigationAppsResource(),
  );

  ResourceRegistry.register(
    NAVIGATION_RESOURCE_URIS.GRAPH,
    "Navigation Graph",
    "High-level navigation graph for the current app (nodes and edges). Use ?appId= to filter by specific app.",
    "application/json",
    (context) => getNavigationGraphResource(undefined, context),
  );

  ResourceRegistry.registerTemplate(
    NAVIGATION_RESOURCE_URIS.GRAPH_WITH_APP_ID,
    "Navigation Graph (App-Specific)",
    "High-level navigation graph filtered by app ID.",
    "application/json",
    async (params) => {
      const appId = decodeUriParam(params.appId);
      return getNavigationGraphResource(appId);
    },
  );

  ResourceRegistry.registerTemplate(
    NAVIGATION_RESOURCE_URIS.GRAPH_BUILD_FILTER,
    "Navigation Graph (Build Filter)",
    "App-union navigation graph annotated for one app build.",
    "application/json",
    getNavigationBuildFilterResource,
  );

  ResourceRegistry.registerTemplate(
    NAVIGATION_RESOURCE_URIS.GRAPH_BUILD_DIFF,
    "Navigation Graph (Build Diff)",
    "Navigation nodes and edges reached by either of two app builds, with presence labels.",
    "application/json",
    getNavigationBuildDiffResource,
  );
}

function registerNavigationHistoryResources(): void {
  ResourceRegistry.register(
    NAVIGATION_RESOURCE_URIS.HISTORY,
    "Navigation History",
    "Ordered navigation history for the current app (nodes and edges).",
    "application/json",
    (context) => getNavigationGraphHistoryResource(NAVIGATION_RESOURCE_URIS.HISTORY, {}, context),
  );

  const historyHandler = async (params: Record<string, string>, context: ResourceReadContext) => {
    try {
      const { cursor, limit } = parseHistoryParams(params);
      const query = new URLSearchParams();
      if (cursor) {
        query.set("cursor", cursor);
      }
      if (limit) {
        query.set("limit", limit.toString());
      }
      const queryString = query.toString();
      const uri = queryString
        ? `${NAVIGATION_RESOURCE_URIS.HISTORY}?${queryString}`
        : NAVIGATION_RESOURCE_URIS.HISTORY;
      return getNavigationGraphHistoryResource(uri, { cursor, limit }, context);
    } catch (error) {
      // parseHistoryParams throws a plain Error on an invalid `limit`. That throw
      // runs outside getNavigationGraphHistoryResource's try/catch, so without this
      // it would escape past the JSON error envelope as a JSON-RPC -32603 (#5853).
      // Log and return the resource's own error envelope instead.
      logger.error(`[NavigationResources] Failed to parse navigation history params: ${error}`);
      return {
        uri: NAVIGATION_RESOURCE_URIS.HISTORY,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            error: `Failed to retrieve navigation history: ${error}`,
          },
          null,
          2,
        ),
      };
    }
  };

  ResourceRegistry.registerTemplateWithReadContext(
    NAVIGATION_RESOURCE_URIS.HISTORY_WITH_CURSOR_AND_LIMIT,
    "Navigation History",
    "Ordered navigation history with pagination support.",
    "application/json",
    historyHandler,
  );

  ResourceRegistry.registerTemplateWithReadContext(
    NAVIGATION_RESOURCE_URIS.HISTORY_WITH_CURSOR,
    "Navigation History",
    "Ordered navigation history with pagination support.",
    "application/json",
    historyHandler,
  );

  ResourceRegistry.registerTemplateWithReadContext(
    NAVIGATION_RESOURCE_URIS.HISTORY_WITH_LIMIT,
    "Navigation History",
    "Ordered navigation history with pagination support.",
    "application/json",
    historyHandler,
  );
}

export function registerNavigationResources(
  options: {
    navigationGraph?: NavigationGraphResourceProvider;
  } = {},
): void {
  if (options.navigationGraph) {
    navigationGraphProvider = options.navigationGraph;
  }

  attachGraphUpdateListener(navigationGraphProvider ?? NavigationGraphManager.getInstance());
  // Session-scoped managers (getInstanceForSession) keep their own listener list,
  // so the global-instance listener above never fires on session-scoped writes.
  // Pass session identity into the independently debounced notification route (#4932).
  NavigationGraphManager.setSessionGraphUpdateListener(scheduleNavigationGraphUpdate);

  registerNavigationGraphResources();
  registerNavigationHistoryResources();

  // Registered before NODE_BY_ID: the base template's `([^/&]+)` node-id capture
  // would otherwise greedily swallow a `?appId=` suffix and win the match (#4933).
  ResourceRegistry.registerTemplate(
    NAVIGATION_RESOURCE_URIS.NODE_BY_ID_WITH_APP_ID,
    "Navigation Graph Node (App-Specific)",
    "Detailed navigation graph node by node ID, resolved under a specific app ID.",
    "application/json",
    async (params) => {
      const nodeId = Number(params.nodeId);
      const appId = decodeUriParam(params.appId);
      if (!Number.isFinite(nodeId)) {
        return buildNavigationNodeError(
          `automobile:navigation/nodes/${params.nodeId}`,
          `Invalid navigation node id: ${params.nodeId}`,
        );
      }
      return getNavigationNodeByIdResource(nodeId, appId);
    },
  );

  ResourceRegistry.registerTemplateWithReadContext(
    NAVIGATION_RESOURCE_URIS.NODE_BY_ID,
    "Navigation Graph Node",
    "Detailed navigation graph node by node ID, including relationships.",
    "application/json",
    async (params, context) => {
      const nodeId = Number(params.nodeId);
      if (!Number.isFinite(nodeId)) {
        return buildNavigationNodeError(
          `automobile:navigation/nodes/${params.nodeId}`,
          `Invalid navigation node id: ${params.nodeId}`,
        );
      }
      return getNavigationNodeByIdResource(nodeId, undefined, context);
    },
  );

  ResourceRegistry.registerTemplateWithReadContext(
    NAVIGATION_RESOURCE_URIS.NODE_BY_SCREEN,
    "Navigation Graph Node (Screen)",
    "Detailed navigation graph node by screen name, including relationships.",
    "application/json",
    async (params, context) => {
      const screenName = decodeUriParam(params.screenName) ?? "";
      if (!screenName) {
        return buildNavigationNodeError(
          "automobile:navigation/nodes?screen=",
          "Screen name is required.",
        );
      }
      return getNavigationNodeByScreenResource(screenName, context);
    },
  );

  // Registered before NODE_SCREENSHOT so the app-scoped variant is matched for
  // `.../screenshot?appId=...` URIs; resolves the screenshot under the named app
  // instead of the daemon's current foreground app (#4933).
  ResourceRegistry.registerTemplate(
    NAVIGATION_RESOURCE_URIS.NODE_SCREENSHOT_WITH_APP_ID,
    "Navigation Node Screenshot (App-Specific)",
    "Screenshot thumbnail for a navigation graph node, resolved under a specific app ID (WebP image).",
    "image/webp",
    async (params) => {
      const nodeId = Number(params.nodeId);
      const appId = decodeUriParam(params.appId);
      if (!Number.isFinite(nodeId)) {
        return {
          uri: `automobile:navigation/nodes/${params.nodeId}/screenshot`,
          mimeType: "application/json",
          text: JSON.stringify({ error: `Invalid node id: ${params.nodeId}` }, null, 2),
        };
      }
      return getNavigationNodeScreenshotResource(nodeId, appId);
    },
  );

  ResourceRegistry.registerTemplateWithReadContext(
    NAVIGATION_RESOURCE_URIS.NODE_SCREENSHOT,
    "Navigation Node Screenshot",
    "Screenshot thumbnail for a navigation graph node (WebP image).",
    "image/webp",
    async (params, context) => {
      const nodeId = Number(params.nodeId);
      if (!Number.isFinite(nodeId)) {
        return {
          uri: `automobile:navigation/nodes/${params.nodeId}/screenshot`,
          mimeType: "application/json",
          text: JSON.stringify({ error: `Invalid node id: ${params.nodeId}` }, null, 2),
        };
      }
      return getNavigationNodeScreenshotResource(nodeId, undefined, context);
    },
  );

  ResourceRegistry.register(
    NAVIGATION_RESOURCE_URIS.TEST_COVERAGE,
    "Navigation Test Coverage Report",
    "Comprehensive test coverage analysis for the navigation graph, including coverage metrics, critical gaps, and recommendations.",
    "application/json",
    async (context) => {
      try {
        const appId = (await getNavigationGraphProvider(context).exportGraphSummary()).appId;

        if (!appId) {
          return {
            uri: NAVIGATION_RESOURCE_URIS.TEST_COVERAGE,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                error:
                  "No current app set. Launch or observe an app first to enable test coverage tracking.",
              },
              null,
              2,
            ),
          };
        }

        const report = await testCoverageAnalyzer.generateReport(appId);
        return {
          uri: NAVIGATION_RESOURCE_URIS.TEST_COVERAGE,
          mimeType: "application/json",
          text: JSON.stringify(report, null, 2),
        };
      } catch (error) {
        logger.error(`[NavigationResources] Failed to generate test coverage report: ${error}`);
        return {
          uri: NAVIGATION_RESOURCE_URIS.TEST_COVERAGE,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              error: `Failed to generate test coverage report: ${error}`,
            },
            null,
            2,
          ),
        };
      }
    },
  );

  logger.info(
    "[NavigationResources] Registered navigation graph resources including test coverage",
  );
}
