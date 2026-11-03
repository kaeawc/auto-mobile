import { resolvePrototypeDataPointer } from "../prototypeData";
import { record, type Raw } from "../prototypeTemplate";

/** Repeat expansion is bounded so one spec cannot produce an unbounded page. */
const MAX_WEB_REPEAT_ITEMS = 200;

/**
 * A repeat's rows: a literal array or a pointer into the spec's data. As on the devices, only
 * object items repeat (scalars are skipped before indices are assigned), up to the item cap.
 */
export function repeatRows(repeat: Raw, data: unknown): unknown[] {
  const itemsPath = record(repeat.items)?.path;
  const items = Array.isArray(repeat.items)
    ? repeat.items
    : typeof itemsPath === "string"
      ? resolvePrototypeDataPointer(data, itemsPath)
      : undefined;
  const rows = Array.isArray(items) ? items.filter((item) => record(item) !== undefined) : [];
  return rows.slice(0, MAX_WEB_REPEAT_ITEMS);
}
