import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";

const LAYOUT_FIELDS = ["cornerRadius", "elevation", "shadowColor", "padding"];
function layoutStyle(value: unknown): boolean {
  const style = record(value);
  if (!style) {
    return false;
  }
  const border = record(style.border);
  return (
    LAYOUT_FIELDS.some((key) => style[key] !== undefined) ||
    border?.color !== undefined ||
    border?.width !== undefined ||
    record(style.width)?.dp !== undefined ||
    record(style.height)?.dp !== undefined
  );
}
export function prototypeMotionV3Fields(spec: unknown): string[] {
  const fields = record(spec)?.motion === "expressive" ? ["motion"] : [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.press !== undefined) {
      fields.push(`${path}.press`);
    }
    if (
      node.animate !== undefined &&
      (layoutStyle(node.style) ||
        (Array.isArray(node.styleWhen) &&
          node.styleWhen.some((entry) => layoutStyle(record(entry)?.style))))
    ) {
      fields.push(`${path}.animate`);
    }
  });
  return fields;
}
const PRESSABLE = new Set([
  "button",
  "iconButton",
  "fab",
  "chip",
  "listItem",
  "switch",
  "checkbox",
  "radioGroup",
  "segmentedButton",
  "select",
  "menu",
]);
export function prototypeMotionV3Error(
  nodes: readonly { value: Raw; path: string }[],
): { path: string; message: string } | undefined {
  const node = nodes.find(
    ({ value }) =>
      value.press !== undefined &&
      !PRESSABLE.has(String(value.type)) &&
      !["onTap", "onLongPress", "onDoubleTap"].some(
        (key) => Array.isArray(value[key]) && value[key].length > 0,
      ),
  );
  return node
    ? { path: `${node.path}.press`, message: "press requires a pressable node" }
    : undefined;
}
export function prototypeMotionV3UnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return `The connected ${platform === "ios" ? "iOS prototype agent" : "CtrlProxy"} does not advertise prototype_motion_v3, so it cannot run the motion at ${fields[0]}. Nothing was shown. Expressive, press and layout animate currently require an updated Android CtrlProxy.`;
}
