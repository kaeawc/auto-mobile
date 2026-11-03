/** The refusal a platform gate reports when the device does not advertise `capability`. */
export function prototypePlatformUnsupported(
  fields: readonly string[],
  platform: "android" | "ios",
  capability: string,
  what: string,
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${capability}, so it cannot run ${what} at ${fields[0]}${more}. Nothing was shown. ${update}, or use a spec without it.`;
}
