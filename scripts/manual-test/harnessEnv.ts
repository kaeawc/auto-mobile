import { isAbsolute } from "node:path";
import { isDaemonNamespaceIsolated } from "../../src/daemon/sharedNamespaceGuard";
import {
  DERIVED_PATH_VARIABLES,
  isInheritedPathOverride,
  privatePathRefusal,
  type HostDefaults,
} from "./privateDaemonEnv";

/** Complete private namespace required before any harness client performs I/O. */
export function privateHarnessEnvRefusal(
  env: Record<string, string | undefined>,
  host: HostDefaults,
): string | undefined {
  for (const key of Object.keys(env)) {
    if (env[key] !== undefined && isInheritedPathOverride(key)) {
      return `Refusing inherited ${key}; source a private daemon env.`;
    }
  }
  if (!env.MT_SERVER?.trim()) {
    return "Private harness env requires MT_SERVER; source the private daemon env first.";
  }
  for (const key of DERIVED_PATH_VARIABLES) {
    const value = env[key]?.trim();
    if (!value || !isAbsolute(value) || value.includes("\0")) {
      return `Private harness env requires absolute ${key}; source the private daemon env first.`;
    }
    const refusal = privatePathRefusal(value, host);
    if (refusal) {
      return refusal;
    }
  }
  if (!isDaemonNamespaceIsolated(env)) {
    return "Private env must isolate the daemon namespace.";
  }
  return undefined;
}
