import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { PROTOTYPE_PAGER_OPTIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/** Authored field order, including descendants and reusable component roots. */
export function prototypePagerOptionFields(spec: unknown): string[] {
  const fields: string[] = [];
  const pending: ({ node: unknown; path: string } | { field: string })[] =
    prototypeSpecNodeRoots(spec).reverse();
  while (pending.length) {
    const task = pending.pop()!;
    if ("field" in task) {
      fields.push(task.field);
      continue;
    }
    const { path } = task;
    const node = record(task.node);
    if (!node) {
      continue;
    }
    const children = prototypeNodeChildren(node);
    const next: typeof pending = [];
    for (const key of Object.keys(node)) {
      if (node.type === "pager" && ["axis", "pageSpacing", "peek", "pageSize"].includes(key)) {
        next.push({ field: `${path}.${key}` });
      } else {
        next.push(
          ...children
            .filter((entry) => entry.suffix === `.${key}` || entry.suffix.startsWith(`.${key}[`))
            .map((entry) => ({ node: entry.value, path: `${path}${entry.suffix}` })),
        );
      }
    }
    pending.push(...next.reverse());
  }
  return fields;
}

/** Refusal for an older renderer, naming the first field in document order. */
export function prototypePagerOptionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_PAGER_OPTIONS_CAPABILITY}, so it cannot draw the pager option at ${fields[0]}${more}: axis, pageSpacing, peek and pageSize. Nothing was shown. ${update}, or remove the pager options.`;
}
