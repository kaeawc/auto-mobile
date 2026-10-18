/**
 * The `managed-execution` session liveness policy name and its idle-deadline exception
 * (epic #11172, #11176). Lives in `src/models` so `src/db` can persist and judge it without
 * importing up into the daemon; the policy's bounds and resolution stay in
 * `daemon/sessionBroker/provisioning/executionLiveness`.
 */

/**
 * - `live`: the owner's lease has not expired.
 * - `suspect`: the lease expired but the grace window has not; the session and
 *   its device are held for the owner token, and only the owner can restore it.
 * - `lapsed`: the lease and any grace are over; the session may be released.
 */
export type LivenessLeasePhase = "live" | "suspect" | "lapsed";

export const MANAGED_EXECUTION_LIVENESS_POLICY = "managed-execution";

/**
 * The shared idle-deadline exception. Without a lease phase (persistence and idle reapers),
 * managed executions defer entirely to owner-loss/recovery rules. Reporting supplies the judged
 * phase: only live and suspect leases advertise exemption, never a lapsed owner.
 */
export function ignoresManagedExecutionIdleDeadline(
  policy: string | null | undefined,
  leasePhase?: LivenessLeasePhase,
): boolean {
  return policy === MANAGED_EXECUTION_LIVENESS_POLICY && leasePhase !== "lapsed";
}
