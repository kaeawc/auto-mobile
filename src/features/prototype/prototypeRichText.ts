import { prototypeNodeChildren } from "./prototypeNodeChildren";
import { PROTOTYPE_RICH_TEXT_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/** Authored or expanded specs, including component roots, repeat templates and slots. */
export function prototypeRichTextFields(spec: unknown): string[] {
  const fields: string[] = [];
  const pending = [{ value: spec, path: "" }];
  while (pending.length) {
    const { value, path } = pending.pop()!;
    if (Array.isArray(value)) {
      pending.push(
        ...value.map((value, index) => ({ value, path: `${path}[${index}]` })).reverse(),
      );
      continue;
    }
    const object = record(value);
    if (!object) {
      continue;
    }
    if (object.type === "text" && object.spans !== undefined) {
      fields.push(`${path}.spans`);
    }
    const children = prototypeNodeChildren(object);
    const next: typeof pending = [];
    for (const [key, child] of Object.entries(object)) {
      // Preserve generic authored structures such as slots and patch nodes, but never opaque data.
      if (["data", "state", "payload", "props", "items"].includes(key)) {
        continue;
      }
      if (["child", "children", "screens"].includes(key)) {
        next.push(
          ...children
            .filter((entry) => entry.suffix === `.${key}` || entry.suffix.startsWith(`.${key}[`))
            .map((entry) => ({ value: entry.value, path: `${path}${entry.suffix}` })),
        );
      } else {
        next.push({ value: child, path: path ? `${path}.${key}` : key });
      }
    }
    pending.push(...next.reverse());
  }
  return fields;
}

export function prototypeRichTextUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_RICH_TEXT_CAPABILITY}, so it cannot draw the rich text at ${fields[0]}${more}. Nothing was shown. ${update}, or use plain text instead of spans.`;
}
