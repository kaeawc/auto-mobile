export function matchesXctestrunPlatform(
  file: string,
  platform?: "device" | "simulator" | "watchSimulator" | "tvSimulator" | "visionSimulator",
): boolean {
  const platformFilter = {
    device: "iphoneos",
    simulator: "iphonesimulator",
    watchSimulator: "watchsimulator",
    tvSimulator: "appletvsimulator",
    visionSimulator: "xrsimulator",
    any: "",
  }[platform || "any"];
  return (
    file.includes(platformFilter) &&
    (platform === "watchSimulator" || !file.includes("watchsimulator")) &&
    (platform === "tvSimulator" || !file.includes("appletvsimulator")) &&
    (platform === "visionSimulator" || !file.includes("xrsimulator"))
  );
}

/** A platform match, narrowed to one scheme's plans when a scheme is named. */
export function matchesXctestrunSelection(
  file: string,
  platform?: Parameters<typeof matchesXctestrunPlatform>[1],
  scheme?: string,
): boolean {
  return matchesXctestrunPlatform(file, platform) && (!scheme || file.startsWith(`${scheme}_`));
}
