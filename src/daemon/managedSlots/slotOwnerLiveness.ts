import { isProcessRunning } from "../../utils/processLiveness";
import {
  compareProcessGenerationTokens,
  currentDaemonProcessGenerationToken,
  readDarwinProcessGenerationToken,
  readLinuxProcessGenerationToken,
} from "../processGeneration";
import type { SlotExecOwner, SlotExecOwnerLiveness } from "./slotRegistry";

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
  return (owner: SlotExecOwner): boolean => {
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

/**
 * The identity this process records when it claims a slot: its PID and its process-generation
 * token (when the platform exposes one).
 */
export function currentSlotOwnerProcess(
  readToken: () => string | undefined = currentDaemonProcessGenerationToken,
  pid: number = process.pid,
): Pick<SlotExecOwner, "pid" | "processGenerationToken"> {
  return { pid, processGenerationToken: readToken() ?? null };
}
