import { logger } from "../utils/logger";
import { toActionableError } from "../models/ActionableError";
import type { NavigationGraphSummary } from "../utils/interfaces/NavigationGraph";
import type {
  NavigationGraphStreamData,
  OnNavigationGraphRequestedCallback,
} from "./deviceDataStreamSocketServer";

/**
 * Minimal exporter contract the on-demand navigation-graph request handler needs.
 *
 * Narrower than {@link import("../utils/interfaces/NavigationGraph").NavigationGraphSummaryProvider}
 * on purpose (YAGNI): the handler only ever exports a summary — for a specific app when the
 * requester names one, or for the current foreground app otherwise. `NavigationGraphManager`
 * satisfies this directly.
 */
export interface NavigationGraphSummaryExporter {
  exportGraphSummary(): Promise<NavigationGraphSummary>;
  exportGraphSummaryForApp(appId: string | null): Promise<NavigationGraphSummary>;
}

/**
 * Convert a NavigationGraphManager summary to the stream data format.
 */
export function convertSummaryToStreamData(summary: {
  appId: string | null;
  nodes: Array<{
    id: number;
    screenName: string;
    visitCount: number;
    screenshotPath?: string | null;
  }>;
  edges: Array<{
    id: number;
    from: string;
    to: string;
    toolName: string | null;
    traversalCount: number;
  }>;
  currentScreen: string | null;
}): NavigationGraphStreamData {
  return {
    appId: summary.appId,
    nodes: summary.nodes.map((node) => ({
      id: node.id,
      screenName: node.screenName,
      visitCount: node.visitCount,
      screenshotPath: node.screenshotPath,
    })),
    edges: summary.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      toolName: edge.toolName,
      traversalCount: edge.traversalCount,
    })),
    currentScreen: summary.currentScreen,
  };
}

/**
 * Build the on-demand navigation-graph request handler wired into the device-data stream server.
 *
 * On success it returns the exported summary as stream data (an empty/no-app graph is still a
 * non-null summary, so the caller emits a `navigation_update` — distinguishable from failure).
 *
 * On export failure it logs a `warn` for traceability and RETHROWS (issue #4918): the previous
 * behavior swallowed the error and returned `null`, which the stream server reports as a plain
 * success ack with no `navigation_update`, leaving a stream-driven client (the desktop Navigation
 * facet) unable to tell "export failed" from "no app / empty graph". Rethrowing routes the failure
 * into the stream server's existing error path, which emits a typed `error` frame keyed to the
 * request id — a contract existing clients already decode.
 */
export function createNavigationGraphRequestHandler(
  exporter: NavigationGraphSummaryExporter,
): OnNavigationGraphRequestedCallback {
  return async (appId?: string | null) => {
    try {
      const summary = appId
        ? await exporter.exportGraphSummaryForApp(appId)
        : await exporter.exportGraphSummary();
      return convertSummaryToStreamData(summary);
    } catch (error) {
      logger.warn(`[Daemon] Failed to export navigation graph on request: ${error}`);
      throw toActionableError(error, "Failed to export navigation graph on request");
    }
  };
}
