import type { ControlSocket } from "./ControlConnection";
import type { ProgressExtendableDeadline } from "../mcpRequestTimeout";

/** One in-flight control-socket request awaiting its terminal response frame. */
export interface PendingSocketRequest {
  id: string;
  sessionId: string;
  socket: ControlSocket;
  admitted: boolean;
  terminal: boolean;
  /** Control frames do not earn an idle exemption; ordinary work has a bounded live deadline. */
  idleDeadline?: ProgressExtendableDeadline;
}

/**
 * The set of control-socket requests that have been read but not yet flushed (#11815). Owns only
 * membership and the per-socket liveness query; writing answers stays with the socket server.
 * Moved from the inline `Set<PendingSocketRequest>` loops in `UnixSocketServer`.
 */
export class PendingRequestTracker implements Iterable<PendingSocketRequest> {
  private readonly pending = new Set<PendingSocketRequest>();

  get size(): number {
    return this.pending.size;
  }

  add(request: PendingSocketRequest): void {
    this.pending.add(request);
  }

  delete(request: PendingSocketRequest): void {
    this.pending.delete(request);
  }

  /** Forget every request that belongs to a socket that has closed. */
  deleteForSocket(socket: ControlSocket): void {
    for (const request of this.pending) {
      if (request.socket === socket) {
        this.pending.delete(request);
      }
    }
  }

  /** True while any request on the socket still has an unexpired idle deadline. */
  hasLiveRequest(socket: ControlSocket, nowMs: number): boolean {
    for (const request of this.pending) {
      if (
        request.socket === socket &&
        request.idleDeadline &&
        request.idleDeadline.value >= nowMs
      ) {
        return true;
      }
    }
    return false;
  }

  [Symbol.iterator](): Iterator<PendingSocketRequest> {
    return this.pending[Symbol.iterator]();
  }
}
