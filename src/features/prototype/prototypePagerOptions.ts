import { PROTOTYPE_PAGER_OPTIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/** Explicit pager options need the capability, even when they request the default behaviour. */
export function prototypePagerOptionFields(spec: unknown): string[] {
  return nodeFields(record(spec)?.root, "root");
}

function nodeFields(value: unknown, path: string): string[] {
  const node = record(value);
  if (!node) {
    return [];
  }
  const fields: string[] = [];
  for (const [key, child] of Object.entries(node)) {
    if (node.type === "pager" && ["axis", "pageSpacing", "peek", "pageSize"].includes(key)) {
      fields.push(`${path}.${key}`);
    } else if (key === "children" && Array.isArray(child)) {
      fields.push(
        ...child.flatMap((entry, index) => nodeFields(entry, `${path}.children[${index}]`)),
      );
    } else if (key === "child") {
      fields.push(...nodeFields(child, `${path}.child`));
    }
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
