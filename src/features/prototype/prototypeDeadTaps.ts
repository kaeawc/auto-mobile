export function prototypeDeadTapsUnsupportedMessage(platform: "android" | "ios"): string {
  const agent = platform === "android" ? "CtrlProxy" : "iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Update the iOS prototype agent by relaunching the app with launchApp prototype: true";
  return `The connected ${agent} does not advertise prototype_dead_tap_v1, so it would ignore window.deadTaps and report no dead taps. Nothing was shown. ${update}, or omit window.deadTaps.`;
}
