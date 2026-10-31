import type { DeviceProfileSelector } from "../../models/ManufacturerProfileIds";
import type { RequirementResult, SessionDeviceProfile } from "../../devices/sessionRequirements";
import type { BrokerResourceRecord } from "./store";
import { ActionableError } from "../../models/ActionableError";
import type { SessionBrokerFailure } from "../../devices/sessionBrokerResult";
import type { SessionBrokerResetMode } from "../../devices/sessionBrokerResult";

export interface ResetOutcome {
  outcome: "clean" | "pending" | `fallback:${Exclude<SessionBrokerResetMode, "none">}`;
  mode: SessionBrokerResetMode;
  phases: Record<string, number>;
  fallbackReason?: string;
}

export type ResetResult = "clean" | "pending" | ResetOutcome;
export type ResetBootRunner = <Result>(operation: () => Promise<Result>) => Promise<Result>;

export interface SessionPreparationTiming {
  createMs?: number;
  bootMs?: number;
  automationReadyMs?: number;
}

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
  /** Applied to the prepared Android session's device after readiness (#14058). */
  deviceProfile?: DeviceProfileSelector;
}

/**
 * Native work uses the existing private assignment and journal authority. The implementation
 * must join/cancel its children on return or leave them fenced by a discoverable native journal.
 * These private resource records never cross the daemon's consumer protocol.
 */
export interface SessionBrokerDevicePort {
  managesResetBootSlots?: boolean;
  prepare(
    resource: BrokerResourceRecord,
    options: SessionDevicePreparationOptions,
  ): Promise<{
    sessionId: string;
    profile: SessionDeviceProfile;
    timing?: SessionPreparationTiming;
  }>;
  /** True only when all prior session work and restoration have settled. */
  release(sessionId: string): Promise<{ settled: boolean }>;
  /**
   * Drives the existing durable deletion journal. "absent" requires authoritative absence, not
   * delete-command success. Shutdown cancellation must settle this call and fence later work.
   * Pending work remains counted and discoverable on the next pass.
   */
  destroy(resource: BrokerResourceRecord, signal?: AbortSignal): Promise<"absent" | "pending">;
  /** Optional until the clean baseline is qualified; absence means zero pooling. */
  reset?(
    resource: BrokerResourceRecord,
    signal?: AbortSignal,
    runResetBoot?: ResetBootRunner,
  ): Promise<ResetResult>;
}

export function unwrap<T>(result: RequirementResult<T>): T {
  if (!result.ok) {
    throw new SessionBrokerFailureError({
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.transient,
    });
  }
  return result.value;
}
