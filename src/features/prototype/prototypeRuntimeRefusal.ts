import type { PrototypeRuntimeKind } from "./prototypePlatformReport";

const runtimeGuidance = {
  ctrlproxy: {
    device: "connected CtrlProxy",
    advice: "Update the connected CtrlProxy",
  },
  iosAgent: {
    device: "connected iOS prototype agent",
    advice:
      "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version",
  },
  iosViewer: {
    device: "iOS Prototype Viewer",
    advice: "Update the iOS Prototype Viewer",
  },
  protoviewer: {
    device: "ProtoViewer",
    advice: "Update ProtoViewer",
  },
  disposableApp: {
    device: "disposable app",
    advice: "Reinstall the disposable app with a template that supports this capability",
  },
  embedded: {
    device: "embedded prototype runtime",
    advice: "Check the host app's prototype SDK and module configuration",
  },
} satisfies Record<PrototypeRuntimeKind, { device: string; advice: string }>;

export function prototypeRuntimeRefusalGuidance(
  platform: "android" | "ios",
  runtime?: PrototypeRuntimeKind,
): { device: string; advice: string } {
  return runtimeGuidance[runtime ?? (platform === "android" ? "ctrlproxy" : "iosAgent")];
}
