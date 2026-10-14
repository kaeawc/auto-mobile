import { PROTOTYPE_SEARCH_BAR_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import type { PrototypeNode, PrototypeSpec } from "./prototypeSpec";

/** Node paths in tree order, including results and repeat templates; no I/O or mutation. */
export function prototypeSearchBarFields(spec: PrototypeSpec): string[] {
  const fields: string[] = [];
  const visit = (node: PrototypeNode, path: string): void => {
    if (node.type === "searchBar") {
      fields.push(path);
    }
    if ("child" in node && node.child) {
      visit(node.child, `${path}.child`);
    }
    if ("children" in node) {
      node.children.forEach((child, index) => visit(child, `${path}.children[${index}]`));
    }
  };
  visit(spec.root, "root");
  return fields;
}

export function prototypeSearchBarUnsupportedMessage(
  fields: readonly string[],
  device: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const connected = device === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    device === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${connected} does not advertise ${PROTOTYPE_SEARCH_BAR_CAPABILITY}, so it cannot render the searchBar at ${fields[0]}${more}. Nothing was shown. ${update}, or use a textField with ordinary result nodes and buttons.`;
}
