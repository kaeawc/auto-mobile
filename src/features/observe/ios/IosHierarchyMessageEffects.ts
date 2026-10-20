import type { CtrlProxyPerfTiming, WebSocketMessage, XCTestHierarchy } from "./types";
import type { ViewHierarchyResult } from "../../../models";

/**
 * The side effects `IOSCtrlProxyClient` performs while routing one inbound runner message.
 *
 * `processMessage` owns the ORDER in which these run; this seam lets a test observe that order
 * through one injected collaborator instead of spying the client's private methods. The default
 * implementation (built by the client) delegates to the client's own members.
 */
export interface IosHierarchyMessageEffects {
  /** True when a push is older than the cached hierarchy and must be dropped. */
  ignoreOlderPush(message: WebSocketMessage): boolean;
  retainScaleMetadata(hierarchy: XCTestHierarchy): void;
  recordNavigation(
    hierarchy: XCTestHierarchy,
    perfTiming?: CtrlProxyPerfTiming | CtrlProxyPerfTiming[],
  ): void;
  convert(hierarchy: XCTestHierarchy): ViewHierarchyResult;
  recordLayoutTelemetry(converted: ViewHierarchyResult): void;
  /** True when the observation-stream push for this request id was suppressed. */
  consumeStreamSuppression(requestId: string): boolean;
  pushToObservationStream(
    converted: ViewHierarchyResult,
    source: XCTestHierarchy | undefined,
    frameContext?: string,
  ): void;
  startScreenshotBackoff(): void;
  notifyPushListeners(hierarchy: XCTestHierarchy): void;
  /** Settles the pending request a decoded response belongs to. */
  resolveRequest(requestId: string, result: unknown): void;
}
