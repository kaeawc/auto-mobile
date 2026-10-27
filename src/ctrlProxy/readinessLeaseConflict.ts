import type { ReadinessClient } from "./RunnerReadinessDependencies";

/**
 * The owner kept the lease for a live session, stream, or in-flight work
 * (#10497); retrying to the deadline cannot change that, so readiness fails
 * fast (#10485). A time-based refusal (recent use, busy owner) is retried
 * within the existing readiness budget instead.
 */
export function isTerminalLeaseConflict(client: ReadinessClient): boolean {
  return (
    (client.isLastConnectionFailureForwardingLeaseConflict?.() ?? false) &&
    !(client.isLastConnectionFailureTransientLeaseConflict?.() ?? false)
  );
}
