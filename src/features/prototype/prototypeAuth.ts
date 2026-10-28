import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";

/**
 * Root `auth` block rules (#14303) the contract cannot express: the block needs `auth` in
 * `requires.platform`, account ids are unique, and an `auth.*` call needs the block's accounts.
 * Kotlin `PrototypeAuthRules` and Swift `PrototypeAuthRules` mirror these checks.
 */
export function prototypeAuthBlockError(root: Raw): PrototypePlatformError | undefined {
  const auth = record(root.auth);
  if (!auth) {
    return undefined;
  }
  const requires = record(root.requires);
  if (!Array.isArray(requires?.platform) || !requires.platform.includes("auth")) {
    return { path: "auth", message: "The auth block requires auth in requires.platform" };
  }
  const seen = new Set<unknown>();
  for (const [index, account] of (Array.isArray(auth.accounts) ? auth.accounts : []).entries()) {
    const id = record(account)?.id;
    if (seen.has(id)) {
      return { path: `auth.accounts[${index}].id`, message: "Duplicate account id" };
    }
    seen.add(id);
  }
  return undefined;
}

/** An `auth.signIn` or `auth.signOut` call without the root `auth` block it signs in to. */
export function prototypeAuthCallError(
  action: Raw,
  path: string,
  root: Raw,
): PrototypePlatformError | undefined {
  const call = action.call;
  return typeof call === "string" && call.startsWith("auth.") && !record(root.auth)
    ? { path: `${path}.call`, message: `${call} requires a root auth block` }
    : undefined;
}
