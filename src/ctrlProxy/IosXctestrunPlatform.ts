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
