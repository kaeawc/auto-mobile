/**
 * Re-owning live managed executions after a daemon restart (#11275).
 *
 * A slot's execution owner is the daemon process holding the execution's session: the session (its
 * owner lease, heartbeat and idle judgement) lives in that daemon, and so do the reservations the
 * reconciler claims before a session exists. The proxy's process is not recorded: the daemon never
 * learns a trusted proxy PID, and a proxy without its daemon session cannot use the slot anyway.
 *
 * A managed-execution session survives a daemon restart (it is rehydrated and its proxy re-binds),
 * but the slot still names the previous daemon's PID, which is now dead. Left alone, the slot looks
 * ownerless: a duplicate acquisition takes it over and the abandonment sweep can fence it. So once
 * this daemon holds such a session again (rehydration, or the proxy's `daemon/registerSession`
 * re-bind) it re-stamps the slot's owner with itself, claiming the slot for the same session UUID.
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  journalOwnersEqual,
  type SlotAssignmentRecord,
  type SlotProcessIdentity,
  type SlotRegistry,
} from "./slotRegistry";

export type ManagedExecutionReownRegistry = Pick<
  SlotRegistry,
  "findExecutionAssignments" | "claimExecution"
>;

export interface ManagedExecutionReownerDependencies {
  registry: () => Promise<ManagedExecutionReownRegistry>;
  /**
   * Whether the host registry exists. A host that never served a managed slot has none, and
   * re-owning must not create it. Defaults to always existing.
   */
  registryExists?: () => boolean;
  /** This daemon, as recorded for a slot's execution owner. */
  owner: () => SlotProcessIdentity;
}

export class ManagedExecutionReowner {
  constructor(private readonly deps: ManagedExecutionReownerDependencies) {}

  /**
   * Re-stamp every slot whose execution is one of `sessionUuids` with this daemon as its owner.
   * Best effort and never throws: a slot already owned by this daemon is left alone, and a slot that
   * changed in the meantime (released, superseded, fenced) is not taken. Returns the re-owned slots.
   */
  async reown(sessionUuids: readonly string[]): Promise<SlotAssignmentRecord[]> {
    if (sessionUuids.length === 0 || this.deps.registryExists?.() === false) {
      return [];
    }
    try {
      const registry = await this.deps.registry();
      const reowned: SlotAssignmentRecord[] = [];
      for (const sessionUuid of sessionUuids) {
        reowned.push(...(await this.reownSession(registry, sessionUuid)));
      }
      return reowned;
    } catch (error) {
      logger.warn(
        `[ManagedSlots] Re-owning managed executions ${sessionUuids.join(", ")} failed: ${errorMessage(error)}`,
        error,
      );
      return [];
    }
  }

  private async reownSession(
    registry: ManagedExecutionReownRegistry,
    sessionUuid: string,
  ): Promise<SlotAssignmentRecord[]> {
    const owner = this.deps.owner();
    const reowned: SlotAssignmentRecord[] = [];
    for (const assignment of await registry.findExecutionAssignments(sessionUuid)) {
      if (assignment.execOwner && journalOwnersEqual(assignment.execOwner, owner)) {
        continue;
      }
      const claimed = await registry.claimExecution(
        { scopeKey: assignment.scopeKey, slotIndex: assignment.slotIndex },
        { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
        { ...owner, sessionUuid },
        { supersedesSessionUuid: sessionUuid },
      );
      if (claimed.kind === "claimed") {
        logger.info(
          `[ManagedSlots] Slot ${assignment.slotIndex} of ${assignment.scopeKey} re-owned by daemon ` +
            `${owner.daemonId} (pid ${owner.pid}) for live session ${sessionUuid}`,
        );
        reowned.push(claimed.assignment);
      } else {
        logger.warn(
          `[ManagedSlots] Slot ${assignment.slotIndex} of ${assignment.scopeKey} was not re-owned ` +
            `for session ${sessionUuid}: ${claimed.kind}`,
        );
      }
    }
    return reowned;
  }
}
