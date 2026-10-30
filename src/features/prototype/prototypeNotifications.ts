import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";

/**
 * Notification rules (#14280) the contract cannot express: the root `notifications` block needs
 * `notifications` in `requires.platform` and unique channel ids; a literal `notifications.post`
 * (or `notifications.schedule`) channel names a declared channel and its action ids are unique; `notifications.cancel` names
 * exactly one target; a channel-scoped `/platform` read names a declared channel. Kotlin and Swift `PrototypeNotificationRules` mirror these checks.
 */
export function prototypeNotificationsBlockError(root: Raw): PrototypePlatformError | undefined {
  const block = record(root.notifications);
  if (!block) {
    return undefined;
  }
  const requires = record(root.requires);
  if (!Array.isArray(requires?.platform) || !requires.platform.includes("notifications")) {
    return {
      path: "notifications",
      message: "The notifications block requires notifications in requires.platform",
    };
  }
  const seen = new Set<unknown>();
  for (const [index, channel] of list(block.channels).entries()) {
    const id = record(channel)?.id;
    if (seen.has(id)) {
      return { path: `notifications.channels[${index}].id`, message: "Duplicate channel id" };
    }
    seen.add(id);
  }
  return undefined;
}

const cancelTargets = ["id", "group", "all"];

/** Cross-argument checks for `notifications.post`, `.schedule` and `.cancel` calls. */
export function prototypeNotificationsCallError(
  action: Raw,
  path: string,
  root: Raw,
): PrototypePlatformError | undefined {
  const args = record(action.args) ?? {};
  if (action.call === "notifications.cancel") {
    const targets = cancelTargets.filter((name) => Object.hasOwn(args, name));
    return targets.length === 1
      ? undefined
      : {
          path: `${path}.args`,
          message: "notifications.cancel takes exactly one of id, group or all",
        };
  }
  return action.call === "notifications.post" || action.call === "notifications.schedule"
    ? postError(args, path, root)
    : undefined;
}

// A bound channel or action list is checked by the runtime once it resolves.
function postError(args: Raw, path: string, root: Raw): PrototypePlatformError | undefined {
  const channel = record(args.channel)?.value;
  if (typeof channel === "string" && !declaredChannels(root).has(channel)) {
    return { path: `${path}.args.channel.value`, message: "Undeclared notification channel" };
  }
  const seen = new Set<unknown>();
  for (const [index, entry] of list(record(args.actions)?.value).entries()) {
    const id = record(entry)?.id;
    if (seen.has(id)) {
      return { path: `${path}.args.actions.value[${index}].id`, message: "Duplicate action id" };
    }
    seen.add(id);
  }
  return undefined;
}

/** Channel-scoped `/platform` keys (#14280), read at `/notifications/channels/<id>/<key>`. */
export const PROTOTYPE_NOTIFICATION_CHANNEL_STATE_KEYS: ReadonlySet<string> = new Set(["blocked"]);

/**
 * Whether a `/notifications` read names a module key, or a channel-scoped key under a declared
 * channel. `tokens` are the decoded pointer segments, the module name first.
 */
export function prototypeNotificationsReadValid(
  tokens: readonly string[],
  root: Raw,
  state: Readonly<Record<string, unknown>>,
): boolean {
  if (tokens[1] === "channels") {
    return (
      tokens.length === 4 &&
      declaredChannels(root).has(tokens[2]) &&
      PROTOTYPE_NOTIFICATION_CHANNEL_STATE_KEYS.has(tokens[3])
    );
  }
  return (
    tokens.length === 2 &&
    Object.hasOwn(state, tokens[1]) &&
    !PROTOTYPE_NOTIFICATION_CHANNEL_STATE_KEYS.has(tokens[1])
  );
}

function declaredChannels(root: Raw): Set<unknown> {
  return new Set(list(record(root.notifications)?.channels).map((channel) => record(channel)?.id));
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
