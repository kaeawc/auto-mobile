import { z } from "zod/v4";
import type { MutationValue } from "./types";

/**
 * Journal key of the Android screen state (wakefulness plus keyguard) that a power-key press or the
 * lock global action changes. Neither the baseline settings clean nor any tool restores it (#14359).
 */
export const SCREEN_STATE_MUTATION_KEY = "screen-state";

const screenStatePriorSchema = z
  .object({
    awake: z.boolean(),
    keyguardShowing: z.boolean(),
    secure: z.boolean().nullable(),
  })
  .strict();

export type ScreenStatePrior = z.infer<typeof screenStatePriorSchema>;

export function screenStatePriorValue(prior: ScreenStatePrior): MutationValue {
  return { state: "present", value: prior };
}

/**
 * A screen state a reset can put back without a credential: awake, no keyguard, and a lock that is
 * definitely not credential-protected. A secure or unreadable lock cannot be re-opened by a reset.
 */
export function isRestorableScreenState(prior: MutationValue): boolean {
  if (prior.state !== "present") {
    return false;
  }
  const parsed = screenStatePriorSchema.safeParse(prior.value);
  return (
    parsed.success &&
    parsed.data.awake &&
    !parsed.data.keyguardShowing &&
    parsed.data.secure === false
  );
}
