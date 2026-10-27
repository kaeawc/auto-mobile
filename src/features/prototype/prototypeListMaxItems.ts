import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

/** Shared lists on one data array impose the smallest authored window. */
export function prototypeListMaxItemsFor(spec: unknown, dataPath: string): number | undefined {
  let maximum: number | undefined;
  walkPrototypeNodes(spec, (node) => {
    const items = record(record(node.repeat)?.items);
    if (
      node.type === "list" &&
      typeof items?.path === "string" &&
      `/data${items.path}` === dataPath &&
      typeof node.maxItems === "number"
    ) {
      maximum = Math.min(maximum ?? Infinity, node.maxItems);
    }
  });
  return maximum;
}
