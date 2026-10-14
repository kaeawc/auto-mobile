import { PROTOTYPE_SEARCH_BAR_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/** Node paths in tree order, including results and repeat templates; no I/O or mutation. */
export function prototypeSearchBarFields(spec: unknown): string[] {
  const root = record(record(spec)?.root);
  if (!root) {
    return [];
  }
  const fields: string[] = [];
  const visit = (node: Record<string, unknown>, path: string): void => {
    if (node.type === "searchBar") {
      fields.push(path);
    }
    const child = record(node.child);
    if (child) {
      visit(child, `${path}.child`);
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((value, index) => {
        const child = record(value);
        if (child) {
          visit(child, `${path}.children[${index}]`);
        }
      });
    }
  };
  visit(root, "root");
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
