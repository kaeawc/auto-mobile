import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";
import { PROTOTYPE_SEARCH_BAR_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/** Node paths in tree order, including component roots and repeat templates. */
export function prototypeSearchBarFields(spec: unknown): string[] {
  const fields: string[] = [];
  const pending = prototypeSpecNodeRoots(spec).reverse();
  while (pending.length) {
    const { node: value, path } = pending.pop()!;
    const node = record(value);
    if (!node) {
      continue;
    }
    if (node.type === "searchBar") {
      fields.push(path);
    }
    // Preserve the existing child-before-children order on mixed containers too.
    const children = prototypeNodeChildren(node).sort(
      (left, right) => Number(right.suffix === ".child") - Number(left.suffix === ".child"),
    );
    for (const child of children.reverse()) {
      pending.push({ node: child.value, path: `${path}${child.suffix}` });
    }
  }
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
