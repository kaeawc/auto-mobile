import { record } from "./prototypeTemplate";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { PROTOTYPE_M3_EXPRESSIVE_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/**
 * Material 3 Expressive vocabulary (#15258): connected button groups, split buttons, FAB menus,
 * wavy progress and the loading indicator. Authored node paths only, including repeat templates.
 */
export function prototypeM3ExpressiveFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "loadingIndicator") {
      fields.push(path);
    } else if (node.type === "segmentedButton" && node.variant === "connected") {
      fields.push(`${path}.variant`);
    } else if (node.type === "progress" && node.variant === "wavy") {
      fields.push(`${path}.variant`);
    } else if (node.type === "button" && record(node.split)) {
      fields.push(`${path}.split`);
    } else if (node.type === "fab" && record(node.menu)) {
      fields.push(`${path}.menu`);
    }
  });
  return fields;
}

export function prototypeM3ExpressiveUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "The iOS agent does not draw Material 3 Expressive components yet";
  return `The ${device} does not advertise ${PROTOTYPE_M3_EXPRESSIVE_CAPABILITY}, so it cannot draw ${fields[0]}${more}. Nothing was shown. ${update}, or remove loadingIndicator nodes, segmentedButton variant connected, progress variant wavy, button split and fab menu.`;
}
