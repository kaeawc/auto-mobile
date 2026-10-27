import { PROTOTYPE_CONTENT_TRANSITION_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";

/** ASCII digits, the first decimal point and an initial minus survive formatting removal. */
export function parseContentTransitionNumber(text: string): number | undefined {
  let token = "";
  let digits = false;
  let decimal = false;
  for (const character of text) {
    if (character >= "0" && character <= "9") {
      token += character;
      digits = true;
    } else if (character === "." && !decimal) {
      token += character;
      decimal = true;
    } else if (character === "-" && token.length === 0) {
      token = "-";
    }
  }
  const value = Number(token);
  return digits && Number.isFinite(value) ? value : undefined;
}

export function contentTransitionDirection(
  previous: string,
  next: string,
): "up" | "down" | "crossfade" {
  const before = parseContentTransitionNumber(previous);
  const after = parseContentTransitionNumber(next);
  return before === undefined || after === undefined || before === after
    ? "crossfade"
    : after > before
      ? "up"
      : "down";
}

export function prototypeContentTransitionFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (
      node.type === "text" &&
      node.contentTransition !== undefined &&
      node.contentTransition !== "none"
    ) {
      fields.push(`${path}.contentTransition`);
    }
  });
  return fields;
}

export function prototypeContentTransitionUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_CONTENT_TRANSITION_CAPABILITY}, required by ${fields[0]}. Nothing was shown. Update the device agent or set contentTransition to none.`;
}
