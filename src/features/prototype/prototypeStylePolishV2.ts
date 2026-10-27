import { PROTOTYPE_STYLE_POLISH_V2_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

/** Authored slots only: opaque data, actions and payloads cannot introduce style features. */
export function prototypeStylePolishV2Fields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const styles = [
      { value: node.style, path: `${path}.style` },
      ...(Array.isArray(node.styleWhen) ? node.styleWhen : []).map((entry, index) => ({
        value: record(entry)?.style,
        path: `${path}.styleWhen[${index}].style`,
      })),
    ];
    for (const { value, path } of styles) {
      fields.push(...styleFields(value, path));
    }
    if (node.type === "scroll" && node.fadeEdges !== undefined) {
      fields.push(`${path}.fadeEdges`);
    }
    if (node.type === "image" && node.filter !== undefined) {
      fields.push(`${path}.filter`);
    }
  });
  return fields;
}

function styleFields(value: unknown, path: string): string[] {
  const style = record(value);
  const fields = ["shadows", "cornerStyle"]
    .filter((key) => style?.[key] !== undefined)
    .map((key) => `${path}.${key}`);
  if (record(style?.border)?.gradient !== undefined) {
    fields.push(`${path}.border.gradient`);
  }
  return fields;
}

export function prototypeStylePolishV2UnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_STYLE_POLISH_V2_CAPABILITY}, so it cannot draw ${fields.join(", ")}. Nothing was shown. ${update}, or remove layered shadows, cornerStyle, gradient borders, scroll fades and image filters.`;
}

/** Cross-field rules supplement the shared structural contract. */
export function prototypeStylePolishV2ObjectError(
  data: Record<string, unknown>,
  kind: string,
  path: string,
): { path: string; message: string } | undefined {
  if (
    kind === "style" &&
    data.shadows !== undefined &&
    (data.elevation !== undefined || data.shadowColor !== undefined)
  ) {
    return {
      path: `${path}.shadows`,
      message: "shadows cannot be combined with elevation or shadowColor",
    };
  }
  if ((kind === "fadeEdges" || kind === "imageFilter") && Object.keys(data).length === 0) {
    return {
      path,
      message:
        kind === "fadeEdges"
          ? "At least one fade edge is required"
          : "At least one image filter field is required",
    };
  }
  return undefined;
}
