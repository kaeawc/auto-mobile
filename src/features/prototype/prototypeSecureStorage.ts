import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";

/**
 * Secure storage rules (#14321) the contract cannot express. `storage.secure` lists `state:` keys
 * the runtime keeps in the Android Keystore or the iOS Keychain instead of plaintext storage:
 * the list needs the `secureStorage` module, each key is a declared string state key that is not
 * also in `storage.keys`, a `secureAuth` entry names a secure key and needs the `biometric` module,
 * and no secure key may leave the device through an emit context. Kotlin and Swift
 * `PrototypeSecureStorageRules` mirror these checks.
 */
export function prototypeSecureStorageError(root: Raw): PrototypePlatformError | undefined {
  const storage = record(root.storage);
  const secure = Array.isArray(storage?.secure) ? storage.secure : undefined;
  if (!storage || !secure) {
    return undefined;
  }
  const platform = strings(record(root.requires)?.platform);
  if (!platform.includes("secureStorage")) {
    return {
      path: "storage.secure",
      message: "storage.secure requires secureStorage in requires.platform",
    };
  }
  const keys = strings(storage.keys);
  for (const [index, entry] of secure.entries()) {
    const message = secureKeyError(entry, root, keys);
    if (message) {
      return { path: `storage.secure[${index}]`, message };
    }
  }
  return secureAuthError(record(storage.secureAuth), secure, platform);
}

/** A `secureAuth` entry that is not a secure key, or a biometric binding without its module. */
function secureAuthError(
  secureAuth: Raw | undefined,
  secure: unknown[],
  platform: string[],
): PrototypePlatformError | undefined {
  for (const name of Object.keys(secureAuth ?? {})) {
    const path = memberPath("storage.secureAuth", name);
    if (!secure.includes(name)) {
      return { path, message: "secureAuth names a key that is not in storage.secure" };
    }
    if (!platform.includes("biometric")) {
      return { path, message: "Biometric secure keys require biometric in requires.platform" };
    }
  }
  return undefined;
}

/** An emit whose `context` binds a secure key: the value would leave the device in the event. */
export function prototypeSecureStorageEmitError(
  action: Raw,
  path: string,
  root: Raw,
): PrototypePlatformError | undefined {
  const context = action.type === "emit" ? record(action.context) : undefined;
  const secure = strings(record(root.storage)?.secure);
  for (const [name, binding] of Object.entries(context ?? {})) {
    const key = record(binding)?.state;
    if (typeof key === "string" && secure.includes(`state:${key}`)) {
      return {
        path: memberPath(`${path}.context`, name),
        message: `Secure storage key state:${key} cannot be sent in an emit context`,
      };
    }
  }
  return undefined;
}

function secureKeyError(entry: unknown, root: Raw, keys: string[]): string | undefined {
  const key = typeof entry === "string" && entry.startsWith("state:") ? entry.slice(6) : undefined;
  if (key === undefined || !prototypeContractPatterns.stateKey.test(key)) {
    return "Secure storage keys are state:<key>";
  }
  const state = record(root.state) ?? {};
  if (!Object.hasOwn(state, key)) {
    return `Secure storage key ${entry as string} is not declared in state`;
  }
  if (typeof state[key] !== "string") {
    return "Secure storage keys must hold a string state value";
  }
  return keys.includes(entry as string)
    ? `Secure storage key ${entry as string} is also listed in storage.keys`
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

const memberPath = (path: string, name: string): string =>
  prototypeContractPatterns.pathKey.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;
