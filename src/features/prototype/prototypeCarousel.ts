import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { PROTOTYPE_CAROUSEL_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/** Authored paths of `carousel` nodes and `pager.indicator`, including components and templates. */
export function prototypeCarouselFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "carousel") {
      fields.push(path);
    }
    if (node.type === "pager" && Object.hasOwn(node, "indicator")) {
      fields.push(`${path}.indicator`);
    }
  });
  return fields;
}

/** Refusal for a device that cannot draw carousels or pager indicators. */
export function prototypeCarouselUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  const feature = fields[0]?.endsWith(".indicator") ? "pager indicator" : "carousel node";
  return `The ${device} does not advertise ${PROTOTYPE_CAROUSEL_CAPABILITY}, so it cannot draw the ${feature} at ${fields[0]}${more}. Nothing was shown. ${update}, or remove carousel nodes and pager indicator.`;
}
