import {
  livenessHandoverMessage,
  livenessHandoverPayload,
  type LivenessHandover,
} from "../proxyLivenessRecovery";
import { DaemonBoundSessionExpiredError } from "./DaemonBoundSessionExpiredError";

/**
 * Raised after automatic liveness recovery was exhausted for a session this proxy holds (#10053).
 * It is a {@link DaemonBoundSessionExpiredError} so every path that already reports a fenced
 * binding reports it, but it carries the structured `daemon_stalled` / `proxy_stalled` handover
 * the harness acts on instead of the generic ownership-lost recovery.
 */
export class DaemonSessionStalledError extends DaemonBoundSessionExpiredError {
  readonly handover: LivenessHandover;

  constructor(sessionUuid: string, handover: LivenessHandover) {
    super(sessionUuid, handover.code);
    this.message = livenessHandoverMessage(handover);
    this.name = "DaemonSessionStalledError";
    this.handover = handover;
  }

  /** The structured error body for a tool result or MCP error. */
  toPayload(): ReturnType<typeof livenessHandoverPayload> {
    return livenessHandoverPayload(this.handover);
  }
}
