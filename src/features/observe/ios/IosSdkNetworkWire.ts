/** Version policy for SdkNetworkRequestEvent; absent keys identify legacy v0. */
export const IOS_SDK_NETWORK_SCHEMA_VERSION = 1;
export const IOS_SDK_NETWORK_DIAGNOSTIC_TAG = "SdkNetworkWire";

export interface SdkNetworkSchemaDiagnostic {
  code: "sdk_network_schema_unsupported";
  receivedVersion: unknown;
  suppressedCount?: number;
  supportedVersion: number;
  bundleId: string | null;
}

// Use the existing success discriminator used by iOS result-returning boundaries.
export type SdkNetworkVersionResult =
  | { success: true; schemaVersion: number }
  | { success: false; diagnostic: SdkNetworkSchemaDiagnostic };

export function decodeSdkNetworkVersion(
  payload: Record<string, unknown>,
  bundleId: string | null,
): SdkNetworkVersionResult {
  const version = "schemaVersion" in payload ? payload.schemaVersion : 0;
  if (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 0 &&
    version <= IOS_SDK_NETWORK_SCHEMA_VERSION
  ) {
    return { success: true, schemaVersion: version };
  }
  return {
    success: false,
    diagnostic: {
      code: "sdk_network_schema_unsupported",
      receivedVersion: version,
      supportedVersion: IOS_SDK_NETWORK_SCHEMA_VERSION,
      bundleId,
    },
  };
}
