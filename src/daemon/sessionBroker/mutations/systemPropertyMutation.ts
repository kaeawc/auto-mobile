import { z } from "zod/v4";
import { logger } from "../../../utils/logger";
import type { MutationValue } from "./types";

/** Exactly the identity `setPreference` journals for a property: no appId, suite or userId. */
const systemPropertyIdentity = z.object({
  store: z.literal("preference"),
  scope: z.literal("systemProperty"),
  appId: z.null(),
  suite: z.null(),
  userId: z.null(),
  key: z.string(),
});

/** `getPreference` records a property's prior as its string value plus type. */
const recordedProperty = z.object({ value: z.string() });

/** Property names a revert may pass to `setprop`/`getprop`; anything else has no revert. */
const PROPERTY_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$/;

/**
 * `ro.*` cannot change once set (a session that set an unset one cannot undo it), `ctl.*`
 * names are init commands rather than stored values, and `sys.powerctl` reboots the device.
 */
function irreversibleProperty(name: string): boolean {
  return name.startsWith("ro.") || name.startsWith("ctl.") || name === "sys.powerctl";
}

/**
 * The Android system property a `setPreference` `scope: "systemProperty"` journal row names,
 * or null when the key is not exactly that identity (no appId, suite or userId), the name fails
 * the strict pattern, or the property is one a revert cannot put back.
 */
export function systemPropertyJournalName(key: string): string | null {
  let identity: unknown;
  try {
    identity = JSON.parse(key);
  } catch (error) {
    // Non-JSON keys are other preference rows (app-data, breadcrumbs); none names a property.
    logger.debug("Preference journal key is not a JSON identity", error);
    return null;
  }
  const parsed = systemPropertyIdentity.safeParse(identity);
  if (!parsed.success) {
    return null;
  }
  const name = parsed.data.key;
  return PROPERTY_NAME_PATTERN.test(name) && !irreversibleProperty(name) ? name : null;
}

/**
 * The value a revert writes back: the journaled string, or `""` for an absent property.
 * `setprop` cannot delete a property, and `getprop` prints the same empty line for an empty
 * property as for an absent one. An unreadable or non-string prior has no revert.
 */
export function systemPropertyRevertValue(prior: MutationValue): string | null {
  if (prior.state === "absent") {
    return "";
  }
  if (prior.state !== "present") {
    return null;
  }
  const parsed = recordedProperty.safeParse(prior.value);
  return parsed.success && !/[\r\n\0]/.test(parsed.data.value) ? parsed.data.value : null;
}
