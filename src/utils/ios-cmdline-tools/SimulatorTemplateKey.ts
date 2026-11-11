import { createHash } from "node:crypto";
import type { PrebootLeanProfileName } from "./SimulatorPrebootProfile";
export interface SimulatorTemplateKey {
  runtime: string;
  runtimeBuild: string;
  xcodeBuild: string;
  deviceType: string;
  profile: PrebootLeanProfileName;
  /** Present only when the template carries the apsd level-off plist, so flag-off clones never inherit it. */
  apsdLogSuppressed?: true;
}
export const TEMPLATE_CLONE_DEFAULT_ENABLED = false;
export function resolveTemplateCloneEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.AUTOMOBILE_IOS_TEMPLATE_CLONE?.trim().toLowerCase();
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return TEMPLATE_CLONE_DEFAULT_ENABLED;
}
export function templateKeyHash(key: SimulatorTemplateKey): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        key.runtime,
        key.runtimeBuild,
        key.xcodeBuild,
        key.deviceType,
        key.profile,
        // Appended only when set, so existing unsuppressed templates keep their names.
        ...(key.apsdLogSuppressed ? ["apsdLogSuppressed"] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 8);
}
export function templateName(key: SimulatorTemplateKey): string {
  return `automobile-template-${templateKeyHash(key)}`;
}
export function isTemplateSimName(name: string): boolean {
  return /^automobile-template-[0-9a-f]{8}$/.test(name);
}
