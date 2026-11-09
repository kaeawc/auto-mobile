import type { ObserveDiff, ObserveDiffNode } from "./output/ObserveResultOutput";
import type { ObserveDiffNodeChange } from "./output/resultOutput/diffTypes";
import { diffAttributes } from "./output/resultOutput/diffComparison";
import { PATH_KEY_SEP, flattenForDiff } from "./output/resultOutput/hierarchy";
import type { ObserveResult } from "../../models";

/**
 * Attributes that may differ between the two sides of a pure text change. The
 * diff key carries the text, so a text change surfaces as a removed + added
 * pair; `view-id` is excluded because the capture layer can derive it from a
 * node's text when the node has no resource id.
 */
const TEXT_CHANGE_ATTRIBUTES: ReadonlySet<string> = new Set(["text", "view-id"]);

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
 * Whether two sides of a node differ only in their text. Uses the shared diff's
 * attribute comparison, so capture metadata it ignores (`extras`, occlusion,
 * `view-id`) cannot make a text change look structural.
 */
function differsOnlyInText(from: ObserveDiffNode, to: ObserveDiffNode): boolean {
  return isTextOnlyDelta(Object.keys(diffAttributes(from.attributes, to.attributes)));
}

/**
 * A delta is a text change only when the text itself changed and nothing else
 * did. A pair with no text delta is a node that moved between containers.
 */
function isTextOnlyDelta(names: readonly string[]): boolean {
  return names.includes("text") && names.every((name) => TEXT_CHANGE_ATTRIBUTES.has(name));
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

/** Whether a matched node changed nothing but its text. */
function isTextOnlyChange(change: ObserveDiffNodeChange): boolean {
  return isTextOnlyDelta(Object.keys(change.changes));
}

/**
 * Identities whose only change in this diff is their text: exactly one removed
 * and one added node share the identity and agree on every other attribute, or
 * a matched (`changed`) node changed nothing but its text.
 */
function textOnlyChanges(diff: ObserveDiff, untrackable: ReadonlySet<string>): Set<string> {
  const changes = new Set<string>();
  const added = groupByIdentity(diff.added);
  for (const [identity, removed] of groupByIdentity(diff.removed)) {
    const counterpart = added.get(identity);
    if (
      removed.length === 1 &&
      counterpart?.length === 1 &&
      differsOnlyInText(removed[0], counterpart[0])
    ) {
      changes.add(identity);
    }
  }
  for (const change of diff.changed) {
    const identity = textFreeIdentity(change.key);
    if (identity !== undefined && isTextOnlyChange(change)) {
      changes.add(identity);
    }
  }
  for (const identity of untrackable) {
    changes.delete(identity);
  }
  return changes;
}

/**
 * Settle-scoped tracker for nodes whose text keeps changing (#17670): a running
 * clock or stopwatch, a typing indicator, a live counter. Such a node changes
 * on every poll, so a comparator that counts every text change never sees two
 * equal reads and every action pays the full settle budget.
 *
 * A node whose text changes, and only its text, in two consecutive diffs is
 * marked volatile for the rest of the settle, and its later text-only changes
 * are dropped from the diff the comparator sees. Everything else still counts:
 * a node added or removed without a counterpart, a volatile node that changes
 * anything besides its text, any other node's change, and `fields` changes.
 */
export class VolatileTextTracker {
  private readonly volatile = new Set<string>();
  private previousChanges = new Set<string>();

  /** Number of nodes currently treated as volatile. */
  get volatileCount(): number {
    return this.volatile.size;
  }

  /** Forget everything; call when consecutive reads are not the same screen. */
  reset(): void {
    this.volatile.clear();
    this.previousChanges = new Set();
  }

  /**
   * Record this diff's text-only changes and return the diff with the text-only
   * changes of volatile nodes removed. The input diff is not mutated.
   * `untrackable` identities (see {@link untrackableIdentities}) are neither
   * tracked nor masked.
   */
  mask(diff: ObserveDiff, untrackable: ReadonlySet<string> = new Set()): ObserveDiff {
    const changes = textOnlyChanges(diff, untrackable);
    for (const identity of changes) {
      if (this.previousChanges.has(identity)) {
        this.volatile.add(identity);
      }
    }
    this.previousChanges = changes;
    const masked = (key: string): boolean => {
      const identity = textFreeIdentity(key);
      return identity !== undefined && changes.has(identity) && this.volatile.has(identity);
    };
    return {
      ...diff,
      added: diff.added.filter((node) => !masked(node.key)),
      removed: diff.removed.filter((node) => !masked(node.key)),
      // Local identity is not unique across subtrees, so a matched node's other
      // changes always count, even when it shares a volatile node's identity.
      changed: diff.changed.filter((change) => !isTextOnlyChange(change) || !masked(change.key)),
    };
  }
}
