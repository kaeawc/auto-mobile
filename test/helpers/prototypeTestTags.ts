import { PROTOTYPE_NODE_TYPES } from "../../src/features/prototype/prototypeSpec";

/** Node types a user taps, types into or drags; each needs a testTag so scripts can find it. */
const INTERACTIVE_TYPES = new Set([
  "button",
  "iconButton",
  "fab",
  "chip",
  "textField",
  "switch",
  "checkbox",
  "radioGroup",
  "select",
  "slider",
  "segmentedButton",
  "tabBar",
  "bottomNav",
  "searchBar",
  "datePicker",
  "timePicker",
  "listItem",
]);
const GESTURE_KEYS = ["onTap", "onLongPress", "onDoubleTap"];
const NODE_TYPES = new Set<string>(PROTOTYPE_NODE_TYPES);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Every node object under `value`; a list item's `trailing` control is part of its row. */
function nodes(value: unknown, found: Json[] = []): Json[] {
  if (Array.isArray(value)) {
    for (const child of value) {
      nodes(child, found);
    }
    return found;
  }
  if (!isObject(value)) {
    return found;
  }
  if (typeof value.type === "string" && NODE_TYPES.has(value.type)) {
    found.push(value);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "trailing") {
      nodes(child, found);
    }
  }
  return found;
}

/** Interactive nodes without a `testTag`, abbreviated for a readable assertion diff. */
export function untaggedInteractiveNodes(spec: unknown): string[] {
  return nodes(spec)
    .filter(
      (node) =>
        (INTERACTIVE_TYPES.has(node.type as string) ||
          GESTURE_KEYS.some((key) => node[key] !== undefined)) &&
        typeof node.testTag !== "string",
    )
    .map((node) => JSON.stringify(node).slice(0, 80));
}
