import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { PrototypePlatformError } from "./prototypePlatform";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Rules for the root `media` block and the `media` platform module (#14253) that the contract
 * cannot express: the block needs `media` in `requires.platform`, `/platform/media` reads name a
 * declared player and one of its state keys, and a literal `player` argument names a declared
 * player.
 */

/** `videoPlayer` nodes at their authored paths. */
function videoPlayers(root: Raw): { node: Raw; path: string }[] {
  const found: { node: Raw; path: string }[] = [];
  walkPrototypeNodes(root, (node, path) => {
    if (node.type === "videoPlayer") {
      found.push({ node, path });
    }
  });
  return found;
}

/**
 * The player ids `media.*` calls and `/platform/media` reads may name: the root `media.players`
 * block, plus the node-scoped player of each `videoPlayer` with an inline `source`, keyed by its id.
 */
export function prototypeMediaPlayers(root: Raw): Set<string> {
  const players = new Set(Object.keys(record(record(root.media)?.players) ?? {}));
  for (const { node } of videoPlayers(root)) {
    if (node.source !== undefined && typeof node.id === "string") {
      players.add(node.id);
    }
  }
  return players;
}

/** The first `videoPlayer` node rule a spec breaks (#14253). */
export function prototypeVideoPlayerError(root: Raw): PrototypePlatformError | undefined {
  const declared = Object.keys(record(record(root.media)?.players) ?? {});
  const platform = record(root.requires)?.platform;
  const state = record(root.state) ?? {};
  for (const { node, path } of videoPlayers(root)) {
    const error = videoPlayerError(node, path, {
      declared,
      media: Array.isArray(platform) && platform.includes("media"),
      state,
    });
    if (error) {
      return error;
    }
  }
  return undefined;
}

function videoPlayerError(
  node: Raw,
  path: string,
  scope: { declared: string[]; media: boolean; state: Raw },
): PrototypePlatformError | undefined {
  const fail = (at: string, message: string) => ({ path: at, message });
  if (!scope.media) {
    return fail(path, "videoPlayer requires media in requires.platform");
  }
  if ((node.player === undefined) === (node.source === undefined)) {
    return fail(path, "A videoPlayer needs exactly one of player or source");
  }
  if (typeof node.player === "string" && !scope.declared.includes(node.player)) {
    return fail(`${path}.player`, "Unknown media player");
  }
  if (node.source !== undefined) {
    if (typeof node.id !== "string" || !prototypeContractPatterns.stateKey.test(node.id)) {
      return fail(path, "An inline videoPlayer needs an id that is a state key");
    }
    if (scope.declared.includes(node.id)) {
      return fail(`${path}.id`, "An inline videoPlayer id cannot repeat a declared player");
    }
  }
  if (typeof node.positionKey === "string" && typeof scope.state[node.positionKey] !== "number") {
    return fail(`${path}.positionKey`, "positionKey must name a declared number state key");
  }
  return undefined;
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
