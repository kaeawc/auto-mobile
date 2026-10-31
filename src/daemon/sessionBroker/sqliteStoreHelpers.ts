import type { Selectable } from "kysely";
import type { BindingRegistryDatabase } from "./registry/sqliteBindingRegistry";
import type { BindingProcessIdentity } from "./registry/bindingRegistry";
import type { BrokerRequestsTable } from "./store";
import { SessionBrokerInvariantError } from "./SessionBrokerInvariantError";

export function isTerminalState(state: BrokerRequestsTable["state"] | undefined): boolean {
  return state === "released" || state === "failed";
}

export function ownsReadyBinding(
  binding: Selectable<BindingRegistryDatabase["slot_assignments"]> | undefined,
  sessionId: string,
  owner: BindingProcessIdentity,
): boolean {
  return Boolean(
    binding?.stable_device_id &&
    binding.state === "ready" &&
    binding.exec_session_uuid === sessionId &&
    binding.exec_owner_daemon_id === owner.daemonId &&
    binding.exec_owner_pid === owner.pid &&
    binding.exec_owner_process_token === (owner.processGenerationToken ?? null),
  );
}

export function ownerIdentity(owner: BindingProcessIdentity): BindingProcessIdentity {
  return {
    daemonId: owner.daemonId,
    pid: owner.pid,
    ...(owner.processGenerationToken === undefined
      ? {}
      : { processGenerationToken: owner.processGenerationToken }),
  };
}

export function requireValue<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    throw new SessionBrokerInvariantError(message);
  }
  return value;
}
