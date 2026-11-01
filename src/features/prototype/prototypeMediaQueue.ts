import type { Rule } from "./prototypeBindingValidation";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import {
  prototypeDataPathPointer,
  prototypeDataPointerTokens,
  resolvePrototypeDataPointer,
} from "./prototypeData";
import type { PrototypePlatformError, PrototypePlatformValueCheck } from "./prototypePlatform";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Rules for a media player's `queue` (#14249) that the contract cannot express: a player has exactly
 * one of `source` or `queue`, the queue points at a declared `/data` array, and each item is a
 * `mediaQueueItem` with a unique `id`. Items added later by data actions are checked by the device.
 */

const ITEM_RULE: Rule = { kind: "ref", name: "mediaQueueItem" };

function keyPath(path: string, key: string): string {
  return prototypeContractPatterns.pathKey.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/** The authored paths of every declared player's `queue`, the fields its capability gates. */
export function prototypeMediaQueueFields(spec: unknown): string[] {
  const players = record(record(record(spec)?.media)?.players) ?? {};
  return Object.entries(players)
    .filter(([, player]) => record(player)?.queue !== undefined)
    .map(([id]) => `${keyPath("media.players", id)}.queue`);
}

/** The first queue rule a spec's `media.players` break. */
export function prototypeMediaQueueError(
  root: Raw,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  const players = record(record(root.media)?.players) ?? {};
  for (const [id, raw] of Object.entries(players)) {
    const player = record(raw) ?? {};
    const path = keyPath("media.players", id);
    const error =
      (player.source === undefined) === (player.queue === undefined)
        ? { path, message: "A media player needs exactly one of source or queue" }
        : player.queue === undefined
          ? undefined
          : queueError(root, player.queue, `${path}.queue`, check);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function queueError(
  root: Raw,
  queue: unknown,
  path: string,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  const pointer = prototypeDataPathPointer(queue);
  const items = pointer === undefined ? undefined : resolvePrototypeDataPointer(root.data, pointer);
  if (pointer === undefined || !Array.isArray(items)) {
    return { path, message: "queue must point to a /data array" };
  }
  const base = prototypeDataPointerTokens(pointer).reduce(keyPath, "data");
  const seen = new Set<unknown>();
  for (const [index, item] of items.entries()) {
    const at = `${base}[${index}]`;
    const error = check(item, ITEM_RULE, at);
    if (error) {
      return error;
    }
    const itemId = record(item)?.id;
    if (seen.has(itemId)) {
      return { path: `${at}.id`, message: "Duplicate queue item id" };
    }
    seen.add(itemId);
  }
  return undefined;
}
