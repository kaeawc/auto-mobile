import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";
import { PROTOTYPE_BAR_SCROLL_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

const bars = new Set(["topAppBar", "bottomNav", "tabBar"]);
type Located = readonly { value: Raw; path: string }[];

/** A stack screen owns its scroll bindings, including when another screen reuses an id. */
export function prototypeBarScrollError(
  nodes: Located,
): { path: string; message: string } | undefined {
  const scopes = ["root"];
  for (const { value, path } of nodes) {
    for (const name of Object.keys(record(value.screens) ?? {})) {
      scopes.push(`${path}.screens[${JSON.stringify(name)}]`);
    }
  }
  const scope = (path: string): string =>
    scopes
      .filter((prefix) => path === prefix || path.startsWith(`${prefix}.`))
      .sort((a, b) => b.length - a.length)[0] ?? "root";
  for (const { value, path } of nodes) {
    if (!bars.has(String(value.type))) {
      continue;
    }
    const active =
      value.onScroll !== undefined && !["pinned", "none"].includes(String(value.onScroll));
    if (value.scroll === undefined && !active) {
      continue;
    }
    const targets = nodes.filter(
      (entry) =>
        entry.value.type === "scroll" &&
        entry.value.id === value.scroll &&
        scope(entry.path) === scope(path),
    );
    if (typeof value.scroll !== "string" || targets.length !== 1) {
      return { path: `${path}.scroll`, message: "Expected one scroll id in the same screen" };
    }
  }
  return undefined;
}

export function prototypeBarScrollFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (bars.has(String(node.type))) {
      for (const key of ["onScroll", "scroll"]) {
        if (node[key] !== undefined) {
          fields.push(`${path}.${key}`);
        }
      }
    }
  });
  return fields;
}

export function prototypeBarScrollUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return `The connected ${platform} renderer does not advertise ${PROTOTYPE_BAR_SCROLL_CAPABILITY} required by ${fields[0]}. Nothing was shown. Update the renderer or remove the bar scroll fields.`;
}
