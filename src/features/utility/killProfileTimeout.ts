import { KILL_PROFILES, type KillProfileStep } from "./KillProfiles";

/**
 * Allowance on top of a profile's screen-off dwell for the wake-state verification (up to ~5 s),
 * the per-step capture/write/verify commands, the final kill and result serialization.
 */
export const KILL_PROFILE_MCP_TIMEOUT_HEADROOM_MS = 60_000;

function dwellMs(step: KillProfileStep): number {
  return step.kind === "screenOff" ? step.minutes * 60_000 : 0;
}

/**
 * Outer request budget for `killProfile`: only `apply` of a profile with a screen-off dwell exceeds
 * the 30 s default, so every other call returns 0 and keeps the caller's deadline.
 */
export function resolveKillProfileBudgetMs(args: Record<string, unknown>): number {
  if (args.action !== "apply" || typeof args.profile !== "string") {
    return 0;
  }
  if (!Object.hasOwn(KILL_PROFILES, args.profile)) {
    return 0;
  }
  const profile = KILL_PROFILES[args.profile as keyof typeof KILL_PROFILES];
  const dwell = profile.steps.reduce((total, step) => total + dwellMs(step), 0);
  return dwell > 0 ? dwell + KILL_PROFILE_MCP_TIMEOUT_HEADROOM_MS : 0;
}
