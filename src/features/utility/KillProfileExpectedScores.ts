import type { KillProfileId } from "./KillProfiles";

/** Stable wire ids shared by the fixture log and host scorer. */
export const SURVIVAL_EVENT_IDS = [
  "workmanager-periodic",
  "workmanager-oneshot",
  "jobscheduler",
  "alarm-exact",
  "alarm-inexact",
  "foreground-service",
  "boot-receiver",
  "push-broadcast",
] as const;

export type SurvivalEventId = (typeof SURVIVAL_EVENT_IDS)[number];
export type SurvivalOutcome = "ran" | "delayed" | "never";
/** Explicitly unmeasured, never coerced into a measured outcome. Remove once measurements land. */
export type ExpectedSurvivalScore = Record<SurvivalEventId, SurvivalOutcome | "TODO_MEASURE">;

const UNMEASURED: ExpectedSurvivalScore = {
  "workmanager-periodic": "TODO_MEASURE",
  "workmanager-oneshot": "TODO_MEASURE",
  jobscheduler: "TODO_MEASURE",
  "alarm-exact": "TODO_MEASURE",
  "alarm-inexact": "TODO_MEASURE",
  "foreground-service": "TODO_MEASURE",
  "boot-receiver": "TODO_MEASURE",
  "push-broadcast": "TODO_MEASURE",
};

export const KILL_PROFILE_EXPECTED_SCORES: Record<KillProfileId, ExpectedSurvivalScore> = {
  "samsung-sleeping": { ...UNMEASURED },
  "samsung-deep-sleeping": { ...UNMEASURED },
  "xiaomi-autostart-off": { ...UNMEASURED },
  "oneplus-deep-optimization": { ...UNMEASURED },
  "recents-swipe-kill": { ...UNMEASURED },
  "recents-swipe-force-stop": { ...UNMEASURED },
  "oneplus-sleep-standby": { ...UNMEASURED },
  "motorola-adaptive": { ...UNMEASURED },
  "user-restricted": { ...UNMEASURED },
  "exact-alarm-denied": { ...UNMEASURED },
};
