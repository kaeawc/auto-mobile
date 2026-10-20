import { ActionableError } from "../../models/ActionableError";

/** One admitted boot another process may not see yet. Times are absolute Timer.now() ms. */
export interface HostBootAdmissionRecord {
  id: string;
  ownerPid: number;
  ownerGenerationToken?: string;
  deviceId?: string;
  /** Holds the listed old device's slot until the replacement is spawned. */
  replacement?: boolean;
  processId?: number;
  processGenerationToken?: string;
  /** Absolute boot-budget deadline, including the period before hand-off. Absent on legacy records. */
  admittedUntilMs?: number;
  handedOffUntilMs?: number;
}

export interface PublishedBootAdmission {
  /** Forget a deleted replacement target. No-op after remove(). */
  clearDeviceId(): void;
  /** Later hand-off data. No-op after remove(). */
  update(
    fields: Pick<
      HostBootAdmissionRecord,
      "deviceId" | "processId" | "handedOffUntilMs" | "replacement"
    >,
  ): void;
  /** Idempotent. */
  remove(): void;
}

export interface HostBootAdmissionRegistry {
  /** Hold the host lock for fn; bounded, abortable waiting. Registry errors remain platform-neutral. */
  withAdmissionLock<T>(
    options: { timeoutMs: number; signal?: AbortSignal },
    fn: () => Promise<T>,
  ): Promise<T>;
  /** Other processes only. Throws if the shared view is unreadable. */
  readPeerAdmissions(): HostBootAdmissionRecord[];
  /** Publishes this process's admission. Throws if the shared view is unwritable. */
  publish(
    fields?: Pick<HostBootAdmissionRecord, "deviceId" | "admittedUntilMs" | "replacement">,
  ): PublishedBootAdmission;
}

/** Platform-neutral failure; the consuming gate maps it to its discovery error. */
export class HostBootAdmissionRegistryError extends ActionableError {
  constructor(
    readonly code: "timeout" | "failed",
    message: string,
  ) {
    super(message);
  }
}
