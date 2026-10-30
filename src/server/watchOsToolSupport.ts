import { ActionableError, type BootedDevice } from "../models";

/**
 * Device-aware tools that accept an Apple Watch simulator. Every other device-aware tool rejects a
 * watch before its handler runs (docs/decisions/watchos-platform.md). Add a tool here only together
 * with the watchOS behaviour and tests that make it safe.
 */
export const WATCHOS_SUPPORTED_TOOLS: ReadonlySet<string> = new Set<string>([
  "installApp",
  "uninstallApp",
  "listApps",
  "launchApp",
  "terminateApp",
  "observe",
]);

export function watchOsUnsupportedToolMessage(toolName: string): string {
  return `${toolName} does not support watchOS yet. Target an Android or iOS device instead.`;
}

/** Throws an ActionableError when `device` is a watch and `toolName` has not opted in. */
export function assertToolSupportsDevicePlatform(
  toolName: string,
  device: Pick<BootedDevice, "platform">,
  supportedTools: ReadonlySet<string> = WATCHOS_SUPPORTED_TOOLS,
): void {
  if (device.platform === "watchos" && !supportedTools.has(toolName)) {
    throw new ActionableError(watchOsUnsupportedToolMessage(toolName));
  }
}
