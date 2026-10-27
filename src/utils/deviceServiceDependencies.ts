import type { iosDeviceResourceCatalog } from "./iosDeviceResourceCatalog";

export interface DeviceServiceDependency {
  readonly tool: string;
  readonly platform: "ios";
  /** Human-readable condition; the scoped provider owns enforcing it. */
  readonly scope?: string;
  readonly resources: readonly (keyof typeof iosDeviceResourceCatalog)[];
  readonly unavailable: string;
  readonly preflight: string;
}

export const deviceServiceDependencies: readonly DeviceServiceDependency[] = [
  {
    tool: "putAppFile",
    platform: "ios",
    scope: "target.domain=media_library",
    resources: ["mediaTranscoding"],
    unavailable: "iOS Simulator photo/video media-library import and transcoding",
    preflight: "src/server/IosSimulatorMediaLibraryProvider.ts",
  },
];

export function getDeviceServiceDependencies(tool: string): readonly DeviceServiceDependency[] {
  return deviceServiceDependencies.filter((entry) => entry.tool === tool);
}
