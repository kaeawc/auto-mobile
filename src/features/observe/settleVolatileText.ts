import type { ObserveDiff, ObserveDiffNode } from "./output/ObserveResultOutput";

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

/** Attributes other than the text, in a key-order-independent form. */
function nonTextAttributes(attributes: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(attributes)
      .filter((name) => !TEXT_CHANGE_ATTRIBUTES.has(name))
      .sort()
      .map((name) => [name, attributes[name]]),
  );
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

/**
 * Identities whose only change in this diff is their text: exactly one removed
 * and one added node share the identity and agree on every other attribute, or
 * a matched (`changed`) node changed nothing but its text.
 */
function textOnlyChanges(diff: ObserveDiff): Set<string> {
  const changes = new Set<string>();
  const added = groupByIdentity(diff.added);
  for (const [identity, removed] of groupByIdentity(diff.removed)) {
    const counterpart = added.get(identity);
    if (
      removed.length === 1 &&
      counterpart?.length === 1 &&
      nonTextAttributes(removed[0].attributes) === nonTextAttributes(counterpart[0].attributes)
    ) {
      changes.add(identity);
    }
  }
  for (const change of diff.changed) {
    const identity = textFreeIdentity(change.key);
    const names = Object.keys(change.changes);
    if (
      identity !== undefined &&
      names.length > 0 &&
      names.every((name) => TEXT_CHANGE_ATTRIBUTES.has(name))
    ) {
      changes.add(identity);
    }
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
   */
  mask(diff: ObserveDiff): ObserveDiff {
    const changes = textOnlyChanges(diff);
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
      changed: diff.changed.filter((change) => !masked(change.key)),
    };
  }
}
