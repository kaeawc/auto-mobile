import type { ObserveDiff, ObserveDiffNode } from "./output/ObserveResultOutput";
import type { ObserveDiffNodeChange } from "./output/resultOutput/diffTypes";
import { diffAttributes } from "./output/resultOutput/diffComparison";
import { PATH_KEY_SEP, flattenForDiff } from "./output/resultOutput/hierarchy";
import type { ObserveResult } from "../../models";

/**
 * Attributes that may differ between the two sides of a volatile change. The
 * diff key carries the text, so a text change surfaces as a removed + added
 * pair; `view-id` is excluded because the capture layer can derive it from a
 * node's text when the node has no resource id. `visible-to-user` covers a
 * blink: a paused Clock stopwatch fades its time text to alpha 0 and back every
 * half second, which flips the flag and leaves the text alone (#17749).
 */
const VOLATILE_CHANGE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "text",
  "view-id",
  "visible-to-user",
]);

/** The attributes whose change alone makes a node tick or blink. */
const VOLATILE_SIGNAL_ATTRIBUTES: readonly string[] = ["text", "visible-to-user"];

/**
 * A node's identity without its text: the diff key
 * (`resource-id \0 bounds \0 text \0 sibling-index`) with the text slot dropped.
 * Returns `undefined` for a key that does not have exactly those four parts.
 */
function textFreeIdentity(key: string): string | undefined {
  const parts = key.split("\0");
  if (parts.length !== 4) {
    return undefined;
  }
  return [parts[0], parts[1], parts[3]].join("\0");
}

/**
 * Whether two sides of a node differ only in their text or visibility. Uses the
 * shared diff's attribute comparison, so capture metadata it ignores (`extras`,
 * occlusion, `view-id`) cannot make a text change look structural.
 */
function differsOnlyVolatile(from: ObserveDiffNode, to: ObserveDiffNode): boolean {
  return isVolatileDelta(Object.keys(diffAttributes(from.attributes, to.attributes)));
}

/**
 * A delta is volatile only when the text or the visibility itself changed and
 * nothing else did. A pair with neither delta is a node that moved between
 * containers.
 */
function isVolatileDelta(names: readonly string[]): boolean {
  return (
    VOLATILE_SIGNAL_ATTRIBUTES.some((name) => names.includes(name)) &&
    names.every((name) => VOLATILE_CHANGE_ATTRIBUTES.has(name))
  );
}

/**
 * Each text-free identity's ancestor path in one read, with the text dropped from
 * every segment; `null` when several nodes hold the identity.
 */
function identityPaths(observation: ObserveResult): Map<string, string | null> {
  const paths = new Map<string, string | null>();
  for (const node of flattenForDiff(observation)) {
    const identity = textFreeIdentity(node.key);
    if (identity === undefined) {
      continue;
    }
    const path = node.pathKey
      .split(PATH_KEY_SEP)
      .map((segment) => textFreeIdentity(segment) ?? segment)
      .join(PATH_KEY_SEP);
    paths.set(identity, paths.has(identity) ? null : path);
  }
  return paths;
}

/**
 * Text-free identities that cannot be tracked across these two reads. The
 * identity drops the ancestor path, so it is trusted only when exactly one node
 * holds it in each read and that node sits under the same (text-free) ancestor
 * path in both. Otherwise a change on one node could pass for a repeat change on
 * another, or a text tick could hide the node moving to another parent.
 */
export function untrackableIdentities(previous: ObserveResult, next: ObserveResult): Set<string> {
  const before = identityPaths(previous);
  const after = identityPaths(next);
  const untrackable = new Set<string>();
  for (const identity of new Set([...before.keys(), ...after.keys()])) {
    const path = before.get(identity);
    if (path === undefined || path === null || path !== after.get(identity)) {
      untrackable.add(identity);
    }
  }
  return untrackable;
}

function groupByIdentity(nodes: readonly ObserveDiffNode[]): Map<string, ObserveDiffNode[]> {
  const groups = new Map<string, ObserveDiffNode[]>();
  for (const node of nodes) {
    const identity = textFreeIdentity(node.key);
    if (identity !== undefined) {
      groups.set(identity, [...(groups.get(identity) ?? []), node]);
    }
  }
  return groups;
}

/** Whether a matched node changed nothing but its text or visibility. */
function isVolatileChange(change: ObserveDiffNodeChange): boolean {
  return isVolatileDelta(Object.keys(change.changes));
}

/**
 * Identities whose only change in this diff is their text or visibility:
 * exactly one removed and one added node share the identity and agree on every
 * other attribute, or a matched (`changed`) node changed nothing but those.
 */
function volatileChanges(diff: ObserveDiff, untrackable: ReadonlySet<string>): Set<string> {
  const changes = new Set<string>();
  const added = groupByIdentity(diff.added);
  for (const [identity, removed] of groupByIdentity(diff.removed)) {
    const counterpart = added.get(identity);
    if (
      removed.length === 1 &&
      counterpart?.length === 1 &&
      differsOnlyVolatile(removed[0], counterpart[0])
    ) {
      changes.add(identity);
    }
  }
  for (const change of diff.changed) {
    const identity = textFreeIdentity(change.key);
    if (identity !== undefined && isVolatileChange(change)) {
      changes.add(identity);
    }
  }
  for (const identity of untrackable) {
    changes.delete(identity);
  }
  return changes;
}

/**
 * Settle-scoped tracker for nodes whose text or visibility keeps changing
 * (#17670, #17749): a running clock or stopwatch, a paused stopwatch blinking,
 * a typing indicator, a live counter. Counting every tick or blink can prevent
 * the required run of equal reads and exhaust the settle budget.
 *
 * A node that changes, and only its text or visibility, in two of the last
 * three diffs is marked volatile for the rest of the settle. Those changes in
 * LATER diffs are dropped from the diff the comparator sees. The two diffs that
 * mark it still count, so at least three changes are needed before masking:
 * a real transition that rewrites one node's text twice and then stops still
 * reads as unstable until a later read confirms it. One intervening equal diff
 * does not discard a sampled blink. The first diff may be the action's own
 * capture against the first poll
 * (#17749); it only feeds this tracker, never the stable-read count.
 * Everything else still counts: a node added or removed without a counterpart,
 * a volatile node that changes anything else, any other node's change, and
 * `fields` changes.
 */
export class VolatileTextTracker {
  private readonly volatile = new Set<string>();
  private readonly recentChanges: Set<string>[] = [];

  /** Number of nodes currently treated as volatile. */
  get volatileCount(): number {
    return this.volatile.size;
  }

  /** Forget everything; call when consecutive reads are not the same screen. */
  reset(): void {
    this.volatile.clear();
    this.recentChanges.length = 0;
  }

  /**
   * Record this diff's text or visibility changes and return the diff with
   * those changes of volatile nodes removed. The input diff is not mutated.
   * `untrackable` identities (see {@link untrackableIdentities}) are neither
   * tracked nor masked.
   */
  mask(diff: ObserveDiff, untrackable: ReadonlySet<string> = new Set()): ObserveDiff {
    const changes = volatileChanges(diff, untrackable);
    for (const previous of this.recentChanges) {
      for (const identity of untrackable) {
        previous.delete(identity);
      }
    }
    // Only a node already volatile before this diff is masked: the diff that
    // promotes a node still counts, so a screen transition made of two
    // text changes on one node is not mistaken for a ticking node (#17692).
    const maskable = new Set([...changes].filter((identity) => this.volatile.has(identity)));
    for (const identity of changes) {
      if (this.recentChanges.some((previous) => previous.has(identity))) {
        this.volatile.add(identity);
      }
    }
    this.recentChanges.push(changes);
    if (this.recentChanges.length > 2) {
      this.recentChanges.shift();
    }
    return withoutChangesOf(diff, maskable);
  }
}

/** `diff` with the volatile changes of `identities` removed; the input is not mutated. */
function withoutChangesOf(diff: ObserveDiff, identities: ReadonlySet<string>): ObserveDiff {
  const masked = (key: string): boolean => {
    const identity = textFreeIdentity(key);
    return identity !== undefined && identities.has(identity);
  };
  return {
    ...diff,
    added: diff.added.filter((node) => !masked(node.key)),
    removed: diff.removed.filter((node) => !masked(node.key)),
    // Local identity is not unique across subtrees, so a matched node's other
    // changes always count, even when it shares a volatile node's identity.
    changed: diff.changed.filter((change) => !isVolatileChange(change) || !masked(change.key)),
  };
}

/**
 * Stateless view of one diff for the settle budget (#17749): `ticks` counts the
 * trackable nodes whose only change is their text or visibility, and `rest` is
 * the diff without those changes. A diff with `ticks > 0` and an empty `rest`
 * changed nothing but ticking or blinking nodes. Never feeds the stability
 * verdict; {@link VolatileTextTracker.mask} still decides what is masked.
 */
export function splitVolatileChanges(
  diff: ObserveDiff,
  untrackable: ReadonlySet<string> = new Set(),
): { ticks: number; rest: ObserveDiff } {
  const changes = volatileChanges(diff, untrackable);
  return { ticks: changes.size, rest: withoutChangesOf(diff, changes) };
}
