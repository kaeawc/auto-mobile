import type { BootedDevice } from "../../../models";
import type { ViewHierarchyResult } from "../../../models/ViewHierarchyResult";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { serverConfig } from "../../../utils/ServerConfig";
import { refreshHierarchySnapshot } from "../HierarchyCapture";
import type { SdkWebSnapshotRequestOptions } from "./CtrlProxySdkWebView";
import { IOSCtrlProxyClient } from "./IOSCtrlProxyClient";
import { IOS_SDK_BRIDGE_OBSERVE_TIMEOUT_MS } from "./IosSdkBridgeReader";
import {
  findWebViewNodes,
  mergeIosSdkWebSnapshots,
  type IosSdkWebMergeSummary,
  type IosSdkWebViewSnapshot,
} from "./iosSdkWebMerge";
import type { CtrlProxySdkWebSnapshotResult } from "./types";

/** The runner call observe needs to read the app's web-view snapshots (#5162). */
export interface IosSdkWebClient {
  requestSdkWebSnapshotForIos(
    options?: SdkWebSnapshotRequestOptions,
  ): Promise<CtrlProxySdkWebSnapshotResult>;
}

export interface IosSdkWebReader {
  /**
   * The app's registered web views in registration order, each with its latest snapshot when it
   * has one; empty when routing is off or the app registered none.
   */
  snapshots(signal?: AbortSignal, timeoutMs?: number): Promise<IosSdkWebViewSnapshot[]>;
}

export interface IosSdkWebReaderOptions {
  client: () => IosSdkWebClient | null;
  enabled?: () => boolean;
  timer?: Timer;
}

async function readSnapshot(
  client: IosSdkWebClient,
  options: SdkWebSnapshotRequestOptions,
): Promise<CtrlProxySdkWebSnapshotResult | null> {
  try {
    return await client.requestSdkWebSnapshotForIos(options);
  } catch (error) {
    // A web view that cannot be read stays XCTest-only; observe keeps the rest of its result.
    logger.warn(`[iOS] SDK web-view snapshot failed: ${errorMessage(error)}`, error);
    return null;
  }
}

export function createIosSdkWebReader(options: IosSdkWebReaderOptions): IosSdkWebReader {
  const enabled = options.enabled ?? (() => serverConfig.isIosSdkObservationBridgeEnabled());
  const timer = options.timer ?? defaultTimer;
  return {
    async snapshots(signal, timeoutMs = Infinity) {
      const deadline = timer.now() + Math.max(0, timeoutMs);
      const remaining = () =>
        Math.max(0, Math.min(IOS_SDK_BRIDGE_OBSERVE_TIMEOUT_MS, deadline - timer.now()));
      const client = enabled() ? options.client() : null;
      if (!client) {
        return [];
      }
      // The first read names no web view: it answers with the registered list and the first one's
      // snapshot, which is all a single web view needs.
      const readTimeoutMs = remaining();
      if (readTimeoutMs === 0) {
        logger.debug("[iOS] SDK web-view snapshot skipped: time budget exhausted");
        return [];
      }
      const first = await readSnapshot(client, { signal, timeoutMs: readTimeoutMs });
      if (first && !first.success && first.failure === "bad_reply") {
        // The reply could not be read; observe keeps its XCTest-only result, with a trace of why.
        logger.warn(`[iOS] SDK web-view snapshot failed: ${first.error ?? first.failure}`);
      }
      const entries = first?.webViews ?? [];
      if (entries.length > 1) {
        // Two or more web views cannot be paired with their WKWebView nodes, so the merge leaves
        // them XCTest-only; reading their snapshots would only add round trips.
        return entries.map(({ webViewId }) => ({ webViewId }));
      }
      // The unnamed read is the single web view's, even when it failed and so names no web view.
      // The registered list and the snapshot come from separate SDK reads; a snapshot that names a
      // different web view than the one registered is not attached to it.
      return entries.map(({ webViewId }) => ({
        webViewId,
        ...(first?.success && first.snapshot && first.webViewId === webViewId
          ? { snapshot: first.snapshot }
          : {}),
      }));
    },
  };
}

/** The production reader: the device's existing runner client, gated by the routing flag. */
export function deviceIosSdkWebReader(
  device: Pick<BootedDevice, "deviceId">,
  timer?: Timer,
): IosSdkWebReader {
  return createIosSdkWebReader({
    client: () => IOSCtrlProxyClient.getExistingInstance(device.deviceId),
    timer,
  });
}

/**
 * Merges the app's web-view snapshots into `hierarchy` in place (#5162). Nothing is read unless the
 * screen shows exactly one WKWebView, so most observations pay no extra round trip.
 */
export async function mergeIosSdkWebInto(
  hierarchy: ViewHierarchyResult,
  reader: IosSdkWebReader,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<IosSdkWebMergeSummary | null> {
  // Only a screen with exactly one outermost WKWebView can merge, so no other screen pays a read.
  if (findWebViewNodes(hierarchy).length !== 1) {
    return null;
  }
  const snapshots = await reader.snapshots(signal, timeoutMs);
  const merged = mergeIosSdkWebSnapshots(hierarchy, snapshots);
  if (merged) {
    // A snapshot bound before the merge indexes the old tree; selectors must see the merged one.
    refreshHierarchySnapshot(hierarchy);
    logger.debug(
      `[iOS] Merged ${merged.attached} DOM elements from ${merged.webViews} web view(s) (${merged.deduplicated} XCTest duplicates removed)`,
    );
  } else if (snapshots.length > 0) {
    logger.debug(
      `[iOS] ${snapshots.length} registered web view(s) not merged: no snapshot, or no one-to-one WKWebView match`,
    );
  }
  return merged;
}
