import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { z } from "zod/v4";
import type { MutationValue } from "./mutations/types";

const APP_LOCALE = "app-locale";

/** A comma-separated language-tag list as `cmd locale get-app-locales` prints it. */
const LOCALE_LIST = /^(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:,[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)*)?$/;

const appLocalePriorSchema = z.object({
  userId: z.number().int().nonnegative(),
  locales: z.string().regex(LOCALE_LIST),
});

export type AppLocalePriorValue = z.infer<typeof appLocalePriorSchema>;

/**
 * The `{ userId, locales }` prior of an app-locale row (`locales` is `""` for an app with no
 * override), or null when the prior is unreadable or not that exact shape.
 */
export function appLocalePrior(prior: MutationValue): AppLocalePriorValue | null {
  if (prior.state !== "present") {
    return null;
  }
  const parsed = appLocalePriorSchema.safeParse(prior.value);
  return parsed.success ? parsed.data : null;
}

/** The `device-setting` journal key of changeLocalization's per-app locale on Android. */
export function appLocaleJournalKey(appId: string): string {
  return JSON.stringify([APP_LOCALE, appId]);
}

/** The app id of an {@link appLocaleJournalKey}, or null for any other key. */
export function appLocaleJournalAppId(key: string): string | null {
  if (!key.startsWith(`["${APP_LOCALE}",`)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch (error) {
    // Not JSON: some other intent's key that only shares the prefix, never an app-locale row.
    logger.debug(`Journal key ${key} is not JSON: ${errorMessage(error)}`);
    return null;
  }
  return Array.isArray(parsed) &&
    parsed.length === 2 &&
    parsed[0] === APP_LOCALE &&
    typeof parsed[1] === "string"
    ? parsed[1]
    : null;
}
