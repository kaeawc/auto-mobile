import type { BootedDevice } from "../../../models";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { serverConfig } from "../../../utils/ServerConfig";
import { IOSCtrlProxyClient } from "./IOSCtrlProxyClient";
import type { IosObservationBridgeState } from "./observationBridgeState";
import type { IosSdkAction, IosSdkObservation } from "./sdkObservationBridge";
import type { CtrlProxySdkActionResult, CtrlProxySdkObservationResult } from "./types";
import type { ViewHierarchyResult } from "../../../models/ViewHierarchyResult";
import type { ObservationBackend, ObservationFallbackReason } from "../../../models/ObserveResult";
import { mergeIosSdkObservation } from "./iosSdkObservationMerge";
import type { SdkBridgeRequestOptions } from "./CtrlProxySdkObservation";

/** Budget for the bridge snapshot taken during observe; the XCTest hierarchy is already in hand. */
export const IOS_SDK_BRIDGE_OBSERVE_TIMEOUT_MS = 2000;

/** The runner calls a backend-routed observe or action needs (#5159). */
export interface IosSdkBridgeClient {
  getObservationBridgeStateForIos(
    appId: string,
    timeoutMs?: number,
  ): Promise<IosObservationBridgeState>;
  requestSdkObservationForIos(
    options?: SdkBridgeRequestOptions,
  ): Promise<CtrlProxySdkObservationResult>;
  requestSdkActionForIos(
    action: IosSdkAction,
    options?: SdkBridgeRequestOptions,
  ): Promise<CtrlProxySdkActionResult>;
}

/**
 * What observe gets from the bridge:
 * - `none`: the routing flag is off, or the app has no registered bridge; observe is unchanged.
 * - `observation`: the bridge's snapshot, to merge under the app node.
 * - `unavailable`: a registered bridge did not produce a snapshot; observe stays XCTest-only and
 *   reports `fallbackReason: unavailable`.
 */
export type IosSdkBridgeObservation =
  | { kind: "none" }
  | { kind: "observation"; observation: IosSdkObservation }
  | { kind: "unavailable"; detail: string };

export interface IosSdkBridgeReader {
  observe(appId: string, signal?: AbortSignal): Promise<IosSdkBridgeObservation>;
}

export interface IosSdkBridgeReaderOptions {
  client: () => IosSdkBridgeClient | null;
  enabled?: () => boolean;
}

export function createIosSdkBridgeReader(options: IosSdkBridgeReaderOptions): IosSdkBridgeReader {
  const enabled = options.enabled ?? (() => serverConfig.isIosSdkObservationBridgeEnabled());
  return {
    async observe(appId, signal) {
      const client = enabled() ? options.client() : null;
      if (!client) {
        return { kind: "none" };
      }
      let state: IosObservationBridgeState;
      try {
        state = await client.getObservationBridgeStateForIos(
          appId,
          IOS_SDK_BRIDGE_OBSERVE_TIMEOUT_MS,
        );
      } catch (error) {
        // A failed capability probe says nothing about a bridge; observe keeps its XCTest result.
        logger.debug(
          `[iOS] SDK bridge discovery failed; observing with XCTest: ${errorMessage(error)}`,
        );
        return { kind: "none" };
      }
      if (state.status !== "available") {
        return { kind: "none" };
      }
      try {
        const reply = await client.requestSdkObservationForIos({
          timeoutMs: IOS_SDK_BRIDGE_OBSERVE_TIMEOUT_MS,
          signal,
        });
        if (reply.success && reply.observation) {
          return { kind: "observation", observation: reply.observation };
        }
        const detail = reply.failure ?? reply.error ?? "no observation";
        logger.warn(`[iOS] SDK bridge snapshot unavailable for ${appId}: ${detail}`);
        return { kind: "unavailable", detail };
      } catch (error) {
        logger.warn(`[iOS] SDK bridge snapshot failed for ${appId}: ${errorMessage(error)}`, error);
        return { kind: "unavailable", detail: errorMessage(error) };
      }
    },
  };
}

/** The production reader: the device's existing runner client, gated by the routing flag. */
export function deviceIosSdkBridgeReader(
  device: Pick<BootedDevice, "deviceId">,
): IosSdkBridgeReader {
  return createIosSdkBridgeReader({
    client: () => IOSCtrlProxyClient.getExistingInstance(device.deviceId),
  });
}

/** What merging the bridge into a hierarchy reports; empty when the app has no bridge. */
export interface IosSdkBridgeMergeResult {
  backend?: ObservationBackend;
  fallbackReason?: ObservationFallbackReason;
}

/**
 * Merges the app's bridge snapshot into `hierarchy` in place (#5159). Observe and the tap-time
 * fresh read both call this, so a node selected from either carries the same bridge identity.
 */
export async function mergeIosSdkBridgeInto(
  hierarchy: ViewHierarchyResult,
  reader: IosSdkBridgeReader,
  signal?: AbortSignal,
): Promise<IosSdkBridgeMergeResult> {
  const appId = hierarchy.packageName;
  if (!appId) {
    return {};
  }
  const outcome = await reader.observe(appId, signal);
  if (outcome.kind === "none") {
    return {};
  }
  const merged =
    outcome.kind === "observation" ? mergeIosSdkObservation(hierarchy, outcome.observation) : null;
  if (merged) {
    logger.debug(
      `[iOS] Merged ${merged.attached} SDK bridge nodes (${merged.deduplicated} XCTest duplicates removed)`,
    );
    return { backend: "sdk" };
  }
  return { backend: "xctest", fallbackReason: "unavailable" };
}
