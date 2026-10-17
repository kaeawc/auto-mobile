import { ProgressExtendableDeadline, resolveMcpRequestTimeoutMsOnce } from "./mcpRequestTimeout";
import type { DaemonRequest } from "./types";

/**
 * Everything a control-socket request's lifetime is judged by, built once when its frame is parsed
 * and passed through admission and dispatch (#11817). Before this, the parse step and the admission
 * step each built their own {@link ProgressExtendableDeadline} for the same frame.
 */
export interface RequestContext {
  /** The frame's request id. */
  readonly id: string;
  /** The control-socket session the frame arrived on. */
  readonly socketSessionId: string;
  /** Clock reading when the frame was parsed; every budget is measured from here. */
  readonly receivedAtMs: number;
  /** The resolved timeout budget, before any progress extension. */
  readonly totalTimeoutMs: number;
  /**
   * Live deadline, anchored at {@link receivedAtMs}. A progress notification extends it up to its
   * own ceiling, so consumers read `.value` live rather than caching it.
   */
  readonly deadline: ProgressExtendableDeadline;
  /** Aborts when the request is cancelled; the same signal the session's cancel route aborts. */
  readonly signal: AbortSignal;
  /**
   * The controller behind {@link signal}. Registered with the session's cancel route today; the
   * remaining cancellation routes fold onto the context in later slices.
   */
  readonly cancellation: AbortController;
}

export function createRequestContext(
  request: DaemonRequest,
  socketSessionId: string,
  receivedAtMs: number,
): RequestContext {
  const totalTimeoutMs = resolveMcpRequestTimeoutMsOnce(request);
  const cancellation = new AbortController();
  return {
    id: request.id,
    socketSessionId: socketSessionId,
    receivedAtMs: receivedAtMs,
    totalTimeoutMs,
    // Untouched for a request that never emits progress, which keeps its exact original deadline.
    deadline: new ProgressExtendableDeadline(receivedAtMs, totalTimeoutMs),
    signal: cancellation.signal,
    cancellation,
  };
}
