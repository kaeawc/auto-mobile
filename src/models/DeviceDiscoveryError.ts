export type DeviceDiscoveryErrorCode = "unavailable" | "failed" | "timeout";

export interface DeviceDiscoveryError {
  code: DeviceDiscoveryErrorCode;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number;
}
