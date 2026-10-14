import { PROTOTYPE_RICH_TEXT_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/** Authored or expanded specs, including component roots, repeat templates and slots. */
export function prototypeRichTextFields(spec: unknown): string[] {
  function walk(value: unknown, path: string): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((entry, index) => walk(entry, `${path}[${index}]`));
    }
    const object = record(value);
    if (!object) {
      return [];
    }
    const fields = object.type === "text" && object.spans !== undefined ? [`${path}.spans`] : [];
    return fields.concat(
      Object.entries(object).flatMap(([key, child]) =>
        // Opaque data and action payloads are not prototype nodes.
        key === "data" || key === "state" || key === "payload" || key === "props" || key === "items"
          ? []
          : walk(child, path ? `${path}.${key}` : key),
      ),
    );
  }
  return walk(spec, "");
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
