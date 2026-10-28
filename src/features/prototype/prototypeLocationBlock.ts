import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";

/**
 * Root `location` subscription block rules (#14324) the contract cannot express: the block needs
 * `location` in `requires.platform` and the `location` permission in `requires.permissions`, the
 * same declarations a `location.request` call needs. Kotlin `PrototypeLocationRules` and Swift
 * `PrototypeLocationRules` mirror these checks.
 */
export function prototypeLocationBlockError(root: Raw): PrototypePlatformError | undefined {
  if (!record(root.location)) {
    return undefined;
  }
  const requires = record(root.requires);
  if (!Array.isArray(requires?.platform) || !requires.platform.includes("location")) {
    return {
      path: "location",
      message: "The location block requires location in requires.platform",
    };
  }
  const permissions = Array.isArray(requires.permissions) ? requires.permissions : [];
  if (!permissions.some((permission) => record(permission)?.name === "location")) {
    return {
      path: "location",
      message: "The location block requires permission location in requires.permissions",
    };
  }
  return undefined;
}
