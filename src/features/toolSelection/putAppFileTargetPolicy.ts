import type { StorageDomain } from "../../server/appFileContract";
import { ToolRegistry } from "../../server/toolRegistry";
import { isToolEnabledForSession, type ToolSelectionReader } from "./toolSelectionPolicy";

/** Only putAppFile controls target enablement; removed-name overrides are ignored, not migrated. */
export const PUT_APP_FILE_TARGET_TOOLS = {
  app_containers: ["putAppFile"],
  user_files: ["putAppFile"],
  media_library: ["putAppFile"],
} as const satisfies Record<StorageDomain, readonly string[]>;

type DeclaredToolDefaults = Pick<typeof ToolRegistry, "getRegisteredTool">;

/**
 * Pure read-only target policy with injected selection and registration readers.
 * Each exact name resolves session override ?? startup default ?? declared default.
 * All domains use the same putAppFile override and default.
 * stageSessionDownloads retains its separate session-bound workflow and selection;
 * it does not grant a unified target through this policy.
 *
 * Today MCP enablement is discovery-only; unlisted tools remain callable. This
 * resolver is not a tools/call gate. It is the single enforcement point for target
 * enablement if a call gate is introduced in a future, separately approved change.
 * No repository writes, deletes, or default changes occur here.
 */
export async function resolvePutAppFileTargetEnablement(
  selection: ToolSelectionReader,
  sessionUuid: string | undefined,
  domain: StorageDomain,
  declaredDefaults: DeclaredToolDefaults = ToolRegistry,
): Promise<boolean> {
  for (const name of PUT_APP_FILE_TARGET_TOOLS[domain]) {
    const registration = declaredDefaults.getRegisteredTool(name);
    if (
      registration &&
      (await isToolEnabledForSession(name, registration.defaultEnabled, sessionUuid, selection))
    ) {
      return true;
    }
  }
  return false;
}
