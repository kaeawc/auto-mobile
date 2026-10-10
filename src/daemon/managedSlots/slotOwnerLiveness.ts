import { isProcessRunning } from "../../utils/processLiveness";
import {
  compareProcessGenerationTokens,
  currentDaemonProcessGenerationToken,
  readDarwinProcessGenerationToken,
  readLinuxProcessGenerationToken,
} from "../processGeneration";
import type { SlotExecOwnerLiveness, SlotProcessIdentity } from "./slotRegistry";

/**
 * Owner liveness for managed slots (#11242 item 5): a recorded execution owner is live while its
 * PID runs AND that PID is still the same process generation (start time) that claimed the slot.
 * A PID the OS has reused for an unrelated process is dead, so it can never pin a slot.
 *
 * Process start identity is the daemon's canonical process-generation token (`processGeneration`):
 * Linux procfs start tick plus boot id, Darwin `ps lstart` in UTC. It is best effort: an owner
 * recorded without a token, a token that cannot be read now, or tokens from incomparable schemes
 * fall back to the PID probe alone, which keeps a possibly-live owner rather than evicting it.
 */
export interface SlotOwnerProcessProbe {
  isRunning(pid: number): boolean;
  /** The PID's current process-generation token, or undefined when it cannot be read. */
  readGenerationToken(pid: number): string | undefined;
}

export function createSlotOwnerProcessProbe(
  platform: NodeJS.Platform = process.platform,
): SlotOwnerProcessProbe {
  return {
    isRunning: (pid) => isProcessRunning(pid),
    readGenerationToken: (pid) => {
      if (platform === "linux") {
        return readLinuxProcessGenerationToken(pid);
      }
      if (platform === "darwin") {
        return readDarwinProcessGenerationToken(pid);
      }
      return undefined;
    },
  };
}

export function createSlotExecOwnerLiveness(
  probe: SlotOwnerProcessProbe = createSlotOwnerProcessProbe(),
): SlotExecOwnerLiveness {
  return (owner: SlotProcessIdentity): boolean => {
    if (!probe.isRunning(owner.pid)) {
      return false;
    }
    const recorded = owner.processGenerationToken;
    if (!recorded) {
      return true;
    }
    const current = probe.readGenerationToken(owner.pid);
    if (current === undefined) {
      return true;
    }
    return compareProcessGenerationTokens(recorded, current) !== "different";
  };
}

/** The default for the registry and the reconciler: PID plus process start identity. */
export const defaultSlotExecOwnerLiveness: SlotExecOwnerLiveness = createSlotExecOwnerLiveness();

/** The sessions this daemon holds as live managed executions (#11275). */
export interface LiveExecutionSessions {
  isLiveManagedExecutionSession(sessionUuid: string): boolean;
  /**
   * Whether this daemon still holds the session at all, whatever its liveness policy. Covers the
   * window between a slot claim and the session adopting the managed-execution policy. Absent:
   * only live managed executions count.
   */
  hasSession?(sessionUuid: string): boolean;
}

/**
 * Reservation ids (`reserve-*`) this process has recorded as a slot's execution owner and not yet
 * superseded or released (#11339). A reservation names no session, so while its attempt runs it is
 * the only thing keeping the slot in use.
 */
export class InFlightSlotReservations {
  private readonly ids = new Set<string>();

  add(reservation: string): void {
    this.ids.add(reservation);
  }

  delete(reservation: string): void {
    this.ids.delete(reservation);
  }

  has(reservation: string): boolean {
    return this.ids.has(reservation);
  }
}

/** The process-wide set the reconciler records into and the daemon's liveness reads. */
export const inFlightSlotReservations = new InFlightSlotReservations();

export interface LiveExecutionSessionsOptions {
  /** This process, whose own records are judged by session, never by PID. Default: this process. */
  thisProcess?: Pick<SlotProcessIdentity, "pid">;
  reservations?: Pick<InFlightSlotReservations, "has">;
}

/**
 * Owner liveness as one daemon judges it (#11275, #11339). A record that names another process is
 * live while that process is (`processLiveness`), or while this daemon still holds the owner's
 * session as a live managed execution: a daemon restart leaves the slot naming the previous, dead
 * daemon until the execution is re-owned, and the session's own liveness keeps the slot in use
 * meanwhile.
 *
 * A record this process wrote is never judged by its PID: that PID is alive for as long as the
 * daemon is, so a record whose clear failed (a busy registry) would pin the slot forever. It is
 * judged only by its session (held by this daemon) or, for a `reserve-*` placeholder, by whether
 * that reservation is still in flight. Settlers and journal owners carry no session and are judged
 * by their process alone.
 */
export function withLiveExecutionSessions(
  processLiveness: SlotExecOwnerLiveness,
  sessions: LiveExecutionSessions,
  options: LiveExecutionSessionsOptions = {},
): SlotExecOwnerLiveness {
  const thisPid = (options.thisProcess ?? { pid: process.pid }).pid;
  const reservations = options.reservations ?? inFlightSlotReservations;
  return (owner) => {
    const sessionUuid =
      "sessionUuid" in owner && typeof owner.sessionUuid === "string" ? owner.sessionUuid : null;
    if (sessionUuid !== null && owner.pid === thisPid) {
      return (
        reservations.has(sessionUuid) ||
        sessions.isLiveManagedExecutionSession(sessionUuid) ||
        (sessions.hasSession?.(sessionUuid) ?? false)
      );
    }
    return (
      processLiveness(owner) ||
      (sessionUuid !== null && sessions.isLiveManagedExecutionSession(sessionUuid))
    );
  };
}

/**
 * The identity this process records when it claims a slot: its PID and its process-generation
 * token (when the platform exposes one).
 */
export function currentSlotOwnerProcess(
  readToken: () => string | undefined = currentDaemonProcessGenerationToken,
  pid: number = process.pid,
): Pick<SlotProcessIdentity, "pid" | "processGenerationToken"> {
  return { pid, processGenerationToken: readToken() ?? null };
}
