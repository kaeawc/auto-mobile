import { KILL_PROFILE_IDS, KILL_PROFILES } from "../../src/features/utility/KillProfiles";
import {
  FIRST_WORK_DELAY_MS,
  FOREGROUND_HEARTBEAT_MS,
  PERIODIC_INTERVAL_MS,
  type ScoringWindow,
} from "./score";

export const FIXTURE_PACKAGE = "dev.jasonpearson.automobile.killprofilefixture";
export const SURVIVAL_MATRIX = KILL_PROFILE_IDS.map((id) => KILL_PROFILES[id]);

/** The fixture uses these delays; broadcast due times are captured when the host sends them. */
export function scoringWindow(
  startMs: number,
  broadcastMs: number,
  deferralMs: number,
  endMs: number,
  observationStartMs: number = startMs,
): ScoringWindow {
  return {
    startMs: observationStartMs,
    deferralMs,
    endMs,
    timing: {
      "workmanager-periodic": {
        firstDueMs: startMs + PERIODIC_INTERVAL_MS,
        intervalMs: PERIODIC_INTERVAL_MS,
      },
      "workmanager-oneshot": { firstDueMs: startMs + FIRST_WORK_DELAY_MS },
      jobscheduler: { firstDueMs: startMs + FIRST_WORK_DELAY_MS },
      "alarm-exact": { firstDueMs: startMs + FIRST_WORK_DELAY_MS },
      "alarm-inexact": { firstDueMs: startMs + FIRST_WORK_DELAY_MS },
      "foreground-service": {
        firstDueMs: startMs + FOREGROUND_HEARTBEAT_MS,
        intervalMs: FOREGROUND_HEARTBEAT_MS,
      },
      "boot-receiver": { firstDueMs: broadcastMs },
      "push-broadcast": { firstDueMs: broadcastMs },
    },
  };
}
