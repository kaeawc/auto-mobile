export function matchesXctestrunPlatform(
  file: string,
  platform?: "device" | "simulator" | "watchSimulator" | "tvSimulator",
): boolean {
  const platformFilter = {
    device: "iphoneos",
    simulator: "iphonesimulator",
    watchSimulator: "watchsimulator",
    tvSimulator: "appletvsimulator",
    any: "",
  }[platform || "any"];
  return (
    file.includes(platformFilter) &&
    (platform === "watchSimulator" || !file.includes("watchsimulator")) &&
    (platform === "tvSimulator" || !file.includes("appletvsimulator"))
  );
}
