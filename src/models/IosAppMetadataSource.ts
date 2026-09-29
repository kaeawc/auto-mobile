/**
 * Source of iOS app metadata — injectable for testing.
 */
export interface IosAppMetadataSource {
  listApps(deviceId?: string): Promise<Record<string, unknown>[]>;
  getPhysicalDeviceAppInfo(
    deviceId: string,
    bundleId: string,
  ): Promise<Record<string, unknown> | null>;
}
