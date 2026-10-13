import { PROTOTYPE_WINDOW_CHROME_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import type { PrototypeSpec } from "./prototypeSpec";

export type PrototypeWindowChrome = "none" | "bar";

/** The refusal for an explicit chromeless request an older device would ignore. */
export function prototypeWindowChromeUnsupportedMessage(platform: "android" | "ios"): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_WINDOW_CHROME_CAPABILITY}, so it would ignore window.chrome "none" and keep the host dismiss bar. Nothing was shown. ${update}, or omit window.chrome (the bar is then kept and reported).`;
}

/** What the spec asks for and what a device with/without the capability will draw. */
export function resolvePrototypeWindowChrome(
  spec: PrototypeSpec,
  { supported, platform }: { supported: boolean; platform: "android" | "ios" },
): { requested?: PrototypeWindowChrome; effective?: PrototypeWindowChrome; refusal?: string } {
  const requested = spec.window.chrome;
  const authored = requested === undefined ? {} : { requested };
  if (spec.window.placement.type !== "fullscreen") {
    return {
      ...authored,
      ...(requested === undefined
        ? {}
        : {
            refusal:
              "window.chrome applies to a fullscreen placement only; omit it for a sheet or floating window. Nothing was shown.",
          }),
    };
  }
  if (!supported && requested === "none") {
    return { ...authored, refusal: prototypeWindowChromeUnsupportedMessage(platform) };
  }
  return {
    ...authored,
    effective: supported
      ? (requested ?? (spec.window.persistence === "device" ? "bar" : "none"))
      : "bar",
  };
}
