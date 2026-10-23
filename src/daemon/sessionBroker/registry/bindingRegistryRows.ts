import { Kysely, type Generated, type Selectable, type Transaction } from "kysely";
import { ActionableError } from "../../../models/ActionableError";
import type { BrokerReceiptTables } from "../store";
import type { DeviceMutationTables } from "../mutations/sqliteJournal";
import {
  isBindingJournalPhaseOpen,
  type AdvanceBindingJournalInput,
  type BindingAssignmentRecord,
  type BindingAssignmentState,
  type BindingExecOwner,
  type BindingJournalEntry,
  type BindingJournalKind,
  type BindingJournalPhase,
  type BindingJournalTarget,
  type BindingPlatform,
  type BindingProcessIdentity,
  type BindingScopeInvalidationReason,
  type BindingScopeRecord,
  type BindingScopeState,
} from "./bindingRegistry";

export interface BindingScopesTable {
  scope_key: string;
  managed_host_scope: string;
  runner_namespace: string;
  runner_incarnation: string;
  state: BindingScopeState;
  invalidation_reason: BindingScopeInvalidationReason | null;
  created_at_ms: number;
  last_acquired_at_ms: number;
  last_released_at_ms: number | null;
  invalidating_at_ms: number | null;
  invalidated_at_ms: number | null;
}

export interface BindingAssignmentsTable {
  scope_key: string;
  slot_index: number;
  role: string;
  platform: BindingPlatform;
  generation: number;
  stable_device_id: string | null;
  device_name: string | null;
  requested_spec_json: string;
  resolved_spec_json: string | null;
  spec_fingerprint: string | null;
  state: BindingAssignmentState;
  exec_owner_daemon_id: string | null;
  exec_owner_pid: number | null;
  exec_owner_process_token: string | null;
  exec_session_uuid: string | null;
  settler_daemon_id: string | null;
  settler_pid: number | null;
  settler_process_token: string | null;
  updated_at_ms: number;
}

export interface BindingJournalTable {
  id: Generated<number>;
  scope_key: string;
  slot_index: number;
  kind: BindingJournalKind;
  phase: BindingJournalPhase;
  platform: BindingPlatform;
  from_generation: number;
  to_generation: number | null;
  binding_generation: number;
  binding_stable_device_id: string | null;
  target_json: string;
  owner_daemon_id: string;
  owner_pid: number;
  owner_process_token: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface BindingRegistryDatabase extends BrokerReceiptTables, DeviceMutationTables {
  slot_scopes: BindingScopesTable;
  slot_assignments: BindingAssignmentsTable;
  slot_journal: BindingJournalTable;
}

export type Executor = Kysely<BindingRegistryDatabase> | Transaction<BindingRegistryDatabase>;

export type ScopeRow = Selectable<BindingScopesTable>;

export type AssignmentRow = Selectable<BindingAssignmentsTable>;

export type JournalRow = Selectable<BindingJournalTable>;

export function toScope(row: ScopeRow): BindingScopeRecord {
  return {
    scopeKey: row.scope_key,
    managedHostScope: row.managed_host_scope,
    runnerNamespace: row.runner_namespace,
    runnerIncarnation: row.runner_incarnation,
    state: row.state,
    createdAtMs: row.created_at_ms,
    lastAcquiredAtMs: row.last_acquired_at_ms,
    lastReleasedAtMs: row.last_released_at_ms,
    invalidationReason: row.invalidation_reason,
    invalidatingAtMs: row.invalidating_at_ms,
    invalidatedAtMs: row.invalidated_at_ms,
  };
}

export function parseSpecJson(json: string | null): unknown {
  if (json === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(json);
  return parsed;
}

export function toExecOwner(row: AssignmentRow): BindingExecOwner | null {
  if (
    row.exec_owner_daemon_id === null ||
    row.exec_owner_pid === null ||
    row.exec_session_uuid === null
  ) {
    return null;
  }
  return {
    daemonId: row.exec_owner_daemon_id,
    pid: row.exec_owner_pid,
    sessionUuid: row.exec_session_uuid,
    processGenerationToken: row.exec_owner_process_token,
  };
}

export function toSettler(row: AssignmentRow): BindingProcessIdentity | null {
  if (row.settler_daemon_id === null || row.settler_pid === null) {
    return null;
  }
  return {
    daemonId: row.settler_daemon_id,
    pid: row.settler_pid,
    processGenerationToken: row.settler_process_token,
  };
}

export function settlerColumns(settler: BindingProcessIdentity | null) {
  return {
    settler_daemon_id: settler?.daemonId ?? null,
    settler_pid: settler?.pid ?? null,
    settler_process_token: settler?.processGenerationToken ?? null,
  };
}

export function toAssignment(row: AssignmentRow): BindingAssignmentRecord {
  return {
    scopeKey: row.scope_key,
    bindingIndex: row.slot_index,
    role: row.role,
    platform: row.platform,
    generation: row.generation,
    stableDeviceId: row.stable_device_id,
    deviceName: row.device_name,
    requestedSpec: parseSpecJson(row.requested_spec_json),
    resolvedSpec: parseSpecJson(row.resolved_spec_json),
    specFingerprint: row.spec_fingerprint,
    state: row.state,
    execOwner: toExecOwner(row),
    settler: toSettler(row),
    updatedAtMs: row.updated_at_ms,
  };
}

export function nullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ActionableError(`Binding journal target field '${field}' is not a string`);
  }
  return value;
}

export function isBindingPlatform(value: unknown): value is BindingPlatform {
  return value === "android" || value === "ios";
}

export function parseJournalTarget(json: string): BindingJournalTarget {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new ActionableError("Binding journal target is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const newPlatform = record.newPlatform;
  if (newPlatform !== undefined && newPlatform !== null && !isBindingPlatform(newPlatform)) {
    throw new ActionableError("Binding journal target field 'newPlatform' is not a platform");
  }
  return {
    ...(newPlatform ? { newPlatform } : {}),
    ...(record.removalRequested === true ? { removalRequested: true as const } : {}),
    ...(typeof record.quarantinedAtMs === "number" && Number.isFinite(record.quarantinedAtMs)
      ? { quarantinedAtMs: record.quarantinedAtMs }
      : {}),
    oldStableId: nullableString(record, "oldStableId"),
    oldName: nullableString(record, "oldName"),
    newName: nullableString(record, "newName"),
    newStableId: nullableString(record, "newStableId"),
    requestedSpec: record.requestedSpec ?? null,
    resolvedSpec: record.resolvedSpec ?? null,
    specFingerprint: nullableString(record, "specFingerprint"),
  };
}

export function toJournalEntry(row: JournalRow): BindingJournalEntry {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    bindingIndex: row.slot_index,
    kind: row.kind,
    phase: row.phase,
    platform: row.platform,
    fromGeneration: row.from_generation,
    toGeneration: row.to_generation,
    binding: { generation: row.binding_generation, stableDeviceId: row.binding_stable_device_id },
    target: parseJournalTarget(row.target_json),
    owner: {
      daemonId: row.owner_daemon_id,
      pid: row.owner_pid,
      processGenerationToken: row.owner_process_token,
    },
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAtMs: row.next_attempt_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export function serializeSpec(spec: unknown): string {
  const json = JSON.stringify(spec ?? null);
  if (json === undefined) {
    throw new ActionableError("Binding spec must be JSON-serializable");
  }
  return json;
}

/** The journal columns one advance writes: phase, merged target, binding and attempt bookkeeping. */
export function journalAdvanceColumns(
  entry: BindingJournalEntry,
  input: AdvanceBindingJournalInput,
  assignment: BindingAssignmentRecord | null,
  nowMs: number,
) {
  return {
    phase: input.phase,
    target_json: serializeSpec({ ...entry.target, ...input.target }),
    to_generation:
      assignment && assignment.generation !== entry.binding.generation
        ? assignment.generation
        : entry.toGeneration,
    ...(assignment
      ? {
          binding_generation: assignment.generation,
          binding_stable_device_id: assignment.stableDeviceId,
        }
      : {}),
    ...(input.attempt
      ? {
          attempts: entry.attempts + 1,
          last_error: input.attempt.error,
          next_attempt_at_ms: input.attempt.nextAttemptAtMs,
        }
      : {}),
    updated_at_ms: nowMs,
  };
}

export function assertOpenPhase(phase: BindingJournalPhase): void {
  if (!isBindingJournalPhaseOpen(phase)) {
    throw new ActionableError(`A binding journal entry cannot open at phase '${phase}'`);
  }
}
