import { ENV, readEnvRaw } from "../../config/env";
export function isAppearanceSyncEnabled(value: string | undefined): boolean {
  return !["0", "false", "off", "no"].includes(value?.trim().toLowerCase() ?? "");
}

export function isAppearanceSyncEnabledFromEnvironment(): boolean {
  return isAppearanceSyncEnabled(readEnvRaw(ENV.APPEARANCE_SYNC));
}
