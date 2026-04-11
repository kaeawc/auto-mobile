/**
 * Result for small Android-only adb shell helpers (notification policy, appops, etc.).
 */
export interface AndroidDeviceShellToolResult {
  success: boolean;
  appId: string;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}
