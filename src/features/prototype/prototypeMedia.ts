import type { PrototypePlatformError } from "./prototypePlatform";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Rules for the root `media` block and the `media` platform module (#14253) that the contract
 * cannot express: the block needs `media` in `requires.platform`, `/platform/media` reads name a
 * declared player and one of its state keys, and a literal `player` argument names a declared
 * player.
 */

/** The ids of the players declared in the root `media.players` block. */
export function prototypeMediaPlayers(root: Raw): Set<string> {
  return new Set(Object.keys(record(record(root.media)?.players) ?? {}));
}

export function prototypeMediaError(root: Raw): PrototypePlatformError | undefined {
  if (!record(root.media)) {
    return undefined;
  }
  const declared = record(root.requires)?.platform;
  return Array.isArray(declared) && declared.includes("media")
    ? undefined
    : { path: "media", message: "Media players require media in requires.platform" };
}

/** A `/media/players/<id>/<key>` read of a declared player's state key. */
export function prototypeMediaReadValid(
  tokens: readonly string[],
  players: ReadonlySet<string>,
  state: Readonly<Record<string, unknown>>,
): boolean {
  return (
    tokens.length === 4 &&
    tokens[1] === "players" &&
    players.has(tokens[2]) &&
    Object.hasOwn(state, tokens[3])
  );
}

/** A `media.*` call whose literal `player` argument names no declared player. */
export function prototypeMediaCallError(
  action: Raw,
  path: string,
  players: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  if (typeof action.call !== "string" || !action.call.startsWith("media.")) {
    return undefined;
  }
  const player = record(record(action.args)?.player);
  return player && typeof player.value === "string" && !players.has(player.value)
    ? { path: `${path}.args.player.value`, message: "Unknown media player" }
    : undefined;
}
