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

// CtrlProxy runs without an Activity; the disposable shell and ProtoViewer register these modules.
export const PROTOTYPE_CTRLPROXY_APP_ONLY_MODULES: ReadonlySet<string> = new Set([
  "biometric",
  "permissions",
  "secureStorage",
]);

// The injected agent excludes the permission prompt module; the saved Viewer enables it.
export const PROTOTYPE_IOS_AGENT_EXCLUDED_MODULES: ReadonlySet<string> = new Set(["permissions"]);

// Only the standalone per-prototype Viewer registers these modules on iOS.
export const PROTOTYPE_IOS_VIEWER_ONLY_MODULES: ReadonlySet<string> = new Set(["notifications"]);

export function prototypeRuntimeRefusalGuidance(
  platform: "android" | "ios",
  runtime?: PrototypeRuntimeKind,
): { device: string; advice: string } {
  return runtimeGuidance[runtime ?? (platform === "android" ? "ctrlproxy" : "iosAgent")];
}
