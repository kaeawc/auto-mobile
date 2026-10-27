import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

export function prototypeWindowMotionFields(spec: unknown): string[] {
  const fields: string[] = [];
  if (record(record(spec)?.window)?.transition !== undefined) {
    fields.push("window.transition");
  }
  walkPrototypeNodes(spec, (node, path) => {
    if (record(node.repeat)?.stagger !== undefined) {
      fields.push(`${path}.repeat.stagger`);
    }
  });
  return fields;
}
