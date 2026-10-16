import type { SessionDeviceProfile } from "../../devices/sessionRequirements";
import type { BrokerResourceRecord } from "./store";
import { ActionableError } from "../../models/ActionableError";
import type { SessionBrokerFailure } from "../../devices/sessionBrokerResult";

export class SessionBrokerFailureError extends ActionableError {
  constructor(readonly failure: SessionBrokerFailure) {
    super(failure.message);
  }
}

export interface SessionDevicePreparationOptions {
  livenessOwnerToken: string;
  signal?: AbortSignal;
  preparationTimeoutMs?: number;
  idleTimeoutMs?: number;
  executionOwnerPid?: number;
}

/**
 * Native work uses the existing private assignment and journal authority. The implementation
 * must join/cancel its children on return or leave them fenced by a discoverable native journal.
 * These private resource records never cross the daemon's consumer protocol.
 */
export interface SessionBrokerDevicePort {
  prepare(
    resource: BrokerResourceRecord,
    options: SessionDevicePreparationOptions,
  ): Promise<{ sessionId: string; profile: SessionDeviceProfile }>;
  /** True only when all prior session work and restoration have settled. */
  release(sessionId: string): Promise<{ settled: boolean }>;
  /**
   * Drives the existing durable deletion journal. "absent" requires authoritative absence, not
   * delete-command success. Pending work remains counted and discoverable on the next pass.
   */
  destroy(resource: BrokerResourceRecord): Promise<"absent" | "pending">;
  /** Optional until the clean baseline is qualified; absence means zero pooling. */
  reset?(resource: BrokerResourceRecord): Promise<"clean" | "pending">;
}
