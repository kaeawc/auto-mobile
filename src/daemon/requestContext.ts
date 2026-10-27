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
  /** The controller behind {@link signal}, registered with the session's cancel route. */
  readonly cancellation: AbortController;
  /** The signal the request's work runs under now; its failure reply is classified against it. */
  readonly owner: RequestOwnerSignal;
}

/**
 * The signal a request's work currently runs under: unset until dispatch adopts the request's
 * cancellation signal, then narrowed to an owner-scoped signal (an MCP forward's, an IDE
 * route's). One per request, so admission and dispatch read the same answer (#11817).
 */
export class RequestOwnerSignal {
  #current: AbortSignal | undefined;

  get signal(): AbortSignal | undefined {
    return this.#current;
  }

  adopt(signal: AbortSignal): void {
    this.#current = signal;
  }
}

export function createRequestContext(
  request: DaemonRequest,
  socketSessionId: string,
  receivedAtMs: number,
  env: NodeJS.ProcessEnv = process.env,
): RequestContext {
  const totalTimeoutMs = resolveMcpRequestTimeoutMsOnce(request, env);
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
    owner: new RequestOwnerSignal(),
  };
}
