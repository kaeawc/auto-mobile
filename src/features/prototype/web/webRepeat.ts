import contract from "../../../../schemas/prototype-spec-contract.json";
import { resolvePrototypeDataPointer } from "../prototypeData";
import { record, type Raw } from "../prototypeTemplate";

/** Repeat expansion is bounded so one spec cannot produce an unbounded page. */
export const MAX_WEB_REPEAT_ITEMS = 200;

/**
 * How many rows a container's repeat draws. A lazy `list` draws up to the list contract limit,
 * capped by its own `maxItems`, as the devices do; every other repeat keeps the web cap.
 */
export function webRepeatLimit(node: Raw): number {
  if (node.type !== "list") {
    return MAX_WEB_REPEAT_ITEMS;
  }
  const listLimit = contract.limits.MAX_PROTOTYPE_LIST_ITEMS;
  const maxItems = node.maxItems;
  return typeof maxItems === "number" && Number.isInteger(maxItems) && maxItems >= 0
    ? Math.min(maxItems, listLimit)
    : listLimit;
}

/**
 * A repeat's rows: a literal array or a pointer into the spec's data. As on the devices, only
 * object items repeat (scalars are skipped before indices are assigned), up to `limit`.
 */
export function webRepeatRows(repeat: Raw, data: unknown, limit: number): unknown[] {
  const itemsPath = record(repeat.items)?.path;
  const items = Array.isArray(repeat.items)
    ? repeat.items
    : typeof itemsPath === "string"
      ? resolvePrototypeDataPointer(data, itemsPath)
      : undefined;
  const rows = Array.isArray(items) ? items.filter((item) => record(item) !== undefined) : [];
  return rows.slice(0, limit);
}
