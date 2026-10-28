import { z } from "zod/v4";
import { logger } from "../../../utils/logger";

const nonEmpty = z.string().min(1);
const appContainerKey = z.union([
  z.tuple([nonEmpty, nonEmpty, z.string()]),
  z.tuple([
    z.literal("app_containers"),
    nonEmpty,
    nonEmpty,
    z.string().nullable(),
    z.string(),
    z.string(),
  ]),
]);

/** Keep the persisted legacy key byte-compatible, including undefined -> null. */
export function legacyAppContainerFileKey(
  appId: unknown,
  container: unknown,
  destinationPath: unknown,
): string {
  return JSON.stringify([appId, container, destinationPath]);
}

/** The scoped file key used for both writes and namespace resets. */
export function scopedAppFileKey(
  target: Record<string, unknown>,
  userId: unknown,
  destinationPath: unknown,
): string {
  return JSON.stringify([
    target.domain,
    target.appId,
    target.container,
    target.namespace,
    userId ?? "default",
    destinationPath,
  ]);
}

/** Only app-private keys can be certified by uninstalling a non-baseline app. */
export function appContainerFileAppId(key: string): string | undefined {
  try {
    const parsed = appContainerKey.safeParse(JSON.parse(key));
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data.length === 3 ? parsed.data[0] : parsed.data[1];
  } catch (error) {
    // Old or malformed journal keys remain uncovered, so ignoring parse failure is safe.
    logger.debug("App-container journal key is not JSON; leaving it uncovered", error);
    return undefined;
  }
}

/** Whether a journal key identifies files staged in the managed Files fixture. */
export function isUserFilesScopedKey(key: string): boolean {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && parsed[0] === "user_files";
  } catch (error) {
    // Malformed legacy keys do not identify a user_files scope.
    logger.debug("User-files journal key is not JSON; leaving it unmatched", error);
    return false;
  }
}
