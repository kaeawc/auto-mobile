import type { Generated } from "kysely";
import type { BindingProcessIdentity } from "./registry/bindingRegistry";
import type { AdmissionRefusalReason, BrokerLimits, ResourceState } from "./admission";

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
}

export interface BrokerAdmissionInput {
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
