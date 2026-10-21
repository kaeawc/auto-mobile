import { ActionableError } from "../../models/ActionableError";
import type { Generated } from "kysely";
import type { BindingProcessIdentity } from "./registry/bindingRegistry";
import type { AdmissionRefusalReason, BrokerLimits, ResourceState } from "./admission";
import type { SessionBrokerTiming } from "../../devices/sessionBrokerResult";
import type { SessionDeviceProfile } from "../../devices/sessionRequirements";

export type BrokerRequestState = "acquiring" | "active" | "releasing" | "released" | "failed";

/** Internal records. None of these allocation keys form part of the consumer API. */
export interface BrokerRequestRecord {
  requestId: string;
  fingerprint: string;
  parameters: unknown;
  owner: BindingProcessIdentity;
  /** The owner relinquished this active session to a restarted provider (graceful shutdown). */
  restartHandoff?: true;
  state: BrokerRequestState;
  resourceId: string | null;
  sessionId: string | null;
  error: string | null;
  errorCode: string | null;
  retryable: boolean;
  timing?: SessionBrokerTiming;
  timingProfile?: SessionDeviceProfile;
}

export interface BrokerResourceRecord {
  resourceId: string;
  allocationIndex: number;
  scopeKey: string;
  profile: unknown;
  state: ResourceState | "destroyed";
  requestId: string | null;
  revision: number;
  idleOrder: number;
  reuseCount?: number;
}

export interface BrokerRequestsTable {
  request_id: string;
  fingerprint: string;
  parameters_json: string;
  owner_json: string;
  state: BrokerRequestState;
  resource_id: string | null;
  session_id: string | null;
  error: string | null;
  error_code: string | null;
  retryable: number | null;
  /** Clock time the receipt became terminal; null while live or for an unstamped legacy row. */
  terminal_at_ms: number | null;
  timing_json: Generated<string | null>;
  timing_profile_json: Generated<string | null>;
  timing_updated_at_ms: Generated<number | null>;
}

export interface BrokerResourcesTable {
  allocation_index: Generated<number>;
  resource_id: string;
  scope_key: string;
  profile_json: string;
  state: BrokerResourceRecord["state"];
  request_id: string | null;
  revision: number;
  idle_order: number;
  reuse_count: Generated<number>;
}

export interface BrokerTimingSample {
  profile: SessionDeviceProfile;
  timing: SessionBrokerTiming;
}

/** Maximum age of an unacknowledged export pin; receipt and cleanup guards still apply. */
export const EXPORT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export interface BrokerExportIdentity {
  prepareId: string;
  requestDigest: string;
}

export interface BrokerExportRecord extends BrokerExportIdentity {
  requestId: string;
  createdAtMs: number;
  acknowledgedAtMs: number | null;
}

export interface BrokerExportsTable {
  prepare_id: string;
  request_id: string;
  request_digest: string;
  created_at_ms: number;
  acknowledged_at_ms: number | null;
}

export class SessionExportIdentityMismatchError extends ActionableError {
  readonly code = "session_export_identity_mismatch";

  constructor() {
    super("Session export identity, digest, or liveness owner does not match the request");
  }
}

export interface BrokerReceiptTables {
  session_broker_requests: BrokerRequestsTable;
  session_broker_resources: BrokerResourcesTable;
  session_broker_exports: BrokerExportsTable;
}

export interface BrokerAdmissionInput {
  resetReadiness?: {
    thresholdMs: number;
    expectedReadyMs: ReadonlyMap<string, number>;
    canWait?: (resourceId: string) => boolean;
    reserveWait?: (requestId: string, resourceId: string) => void;
  };
  timingStartedAtMs?: number;
  export?: BrokerExportIdentity;
  requestId: string;
  /** Canonical requirements + initialization + consumer ownership, excluding transport details. */
  fingerprint: string;
  parameters: unknown;
  owner: BindingProcessIdentity;
  limits: BrokerLimits;
  /** Pure catalog resolver. Called on a miss before reserving or evicting, never on a hit. */
  resolveCreation: () => unknown;
  /** Pure predicate, evaluated on the current inventory inside the reservation transaction. */
  matches: (profile: unknown) => boolean;
}

export type BrokerAdmission =
  | { kind: "existing"; request: BrokerRequestRecord }
  | { kind: "wait"; request: BrokerRequestRecord; resourceId: string; waitMs: number }
  | {
      kind: "create" | "reuse" | "evict";
      request: BrokerRequestRecord;
      resource: BrokerResourceRecord;
    }
  | { kind: "refused"; request: BrokerRequestRecord; reason: AdmissionRefusalReason };

export interface DestructionTicket {
  resourceId: string;
  revision: number;
}

export interface BrokerAbandonment {
  request: BrokerRequestRecord;
  ticket?: DestructionTicket;
}

export function destructionTicket(resource: BrokerResourceRecord): DestructionTicket {
  return { resourceId: resource.resourceId, revision: resource.revision };
}
