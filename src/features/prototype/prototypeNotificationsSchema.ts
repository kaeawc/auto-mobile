import { z } from "zod";
import { prototypeContractPatterns } from "./prototypeContractPatterns";

/** One notification channel (#14280): an id the posts reference, a label and an importance. */
function notificationChannelSchema() {
  return z
    .object({
      id: z.string().max(64).regex(prototypeContractPatterns.stateKey),
      // \S excludes exactly the contract blankText set, and advertises as a pattern.
      name: z.string().max(64).regex(/\S/),
      importance: z.enum(["min", "low", "default", "high"]),
      description: z.string().max(256).optional(),
      showBadge: z.boolean().optional(),
    })
    .strict();
}

/**
 * Root `notifications` block: the channels `notifications.post` may name; needs `notifications` in
 * `requires.platform`. Built per call so the advertised JSON schema inlines it instead of a `$ref`.
 */
export function prototypeNotificationsSchema() {
  return z
    .object({ channels: z.array(notificationChannelSchema()).min(1).max(8) })
    .strict()
    .describe(
      "Notification channels for notifications.post (prototype_platform_notifications_v1); unique ids",
    );
}
