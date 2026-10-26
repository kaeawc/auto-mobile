import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { PROTOTYPE_REFRESH_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/** Authored paths of `scroll.refresh`, including component definitions and repeat templates. */
export function prototypeRefreshFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if ((node.type === "scroll" || node.type === "list") && Object.hasOwn(node, "refresh")) {
      fields.push(`${path}.refresh`);
    }
  });
  return fields;
}

/** Refusal for a device that cannot draw pull-to-refresh. */
export function prototypeRefreshUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  return `The ${device} does not advertise ${PROTOTYPE_REFRESH_CAPABILITY}, so it cannot draw pull-to-refresh at ${fields.join(", ")}. Nothing was shown. ${update}, or remove scroll.refresh.`;
}
