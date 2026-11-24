import type { UnsettledNode } from "../../models";
import type { ObserveDiff } from "./output/ObserveResultOutput";
import { diffElementId, diffLabel } from "./output/resultOutput/diffSelectors";

/** At most this many entries, so the field stays a hint rather than a second diff. */
export const MAX_UNSETTLED_BY = 3;

function selectorFields(elementId: string | undefined, label: string | undefined) {
  return {
    ...(elementId === undefined ? {} : { elementId }),
    ...(label === undefined ? {} : { label }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A node's own attributes, including those an XML-parsed capture nests under `$`. */
function ownAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return { ...asRecord(attributes.$), ...attributes };
}

/**
 * One changed node: its selector and first changed attribute. A change to an XML-parsed node's
 * nested `$` attribute bag is unwrapped to the attribute inside it that changed.
 */
function changedNode(change: ObserveDiff["changed"][number]): UnsettledNode {
  const [first] = Object.entries(change.changes);
  if (first === undefined) {
    return {
      ...selectorFields(change.selector?.elementId, change.selector?.label),
      field: "changed",
    };
  }
  const [key, { from, to }] = first;
  if (key !== "$") {
    return { ...selectorFields(change.selector?.elementId, change.selector?.label), field: key };
  }
  const before = asRecord(from);
  const after = asRecord(to);
  const nested = [...new Set([...Object.keys(before), ...Object.keys(after)])].find(
    (name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]),
  );
  return {
    ...selectorFields(
      change.selector?.elementId ?? diffElementId(after),
      change.selector?.label ?? diffLabel(after),
    ),
    field: nested ?? key,
  };
}

/**
 * The nodes a settle diff says are still changing (#19123): changed nodes with their first
 * changed attribute, then added and removed nodes, then changed top-level fields. Returns
 * `undefined` for an empty diff.
 */
export function unsettledByFromDiff(diff: ObserveDiff): UnsettledNode[] | undefined {
  const changed = diff.changed.map(changedNode);
  const appeared = (nodes: ObserveDiff["added"], field: "added" | "removed") =>
    nodes.map((node) => {
      const attributes = ownAttributes(node.attributes);
      return { ...selectorFields(diffElementId(attributes), diffLabel(attributes)), field };
    });
  const fields = Object.keys(diff.fields ?? {}).map((field) => ({ field }));
  const entries: UnsettledNode[] = [
    ...changed,
    ...appeared(diff.added, "added"),
    ...appeared(diff.removed, "removed"),
    ...fields,
  ].slice(0, MAX_UNSETTLED_BY);
  return entries.length > 0 ? entries : undefined;
}
