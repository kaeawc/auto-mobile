import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";

/**
 * Secure storage rules (#14321) the contract cannot express. `storage.secure` lists `state:` keys
 * the runtime keeps in the Android Keystore or the iOS Keychain instead of plaintext storage:
 * the list needs the `secureStorage` module, each key is a declared string state key that is not
 * also in `storage.keys`, a `secureAuth` entry names a secure key and needs the `biometric` module,
 * and no secure key may bind into an emit context, route params, platform args or a data-write
 * value, or into a `request` that does not opt in with `allowSecureInRequest: true`. Kotlin and Swift
 * `PrototypeSecureStorageRules` mirror these checks, except the data-write value check (#18669).
 */
export function prototypeSecureStorageError(root: Raw): PrototypePlatformError | undefined {
  const storage = record(root.storage);
  if (!storage) {
    return undefined;
  }
  const platform = strings(record(root.requires)?.platform);
  const listed = Array.isArray(storage.secure);
  const secure: unknown[] = listed ? (storage.secure as unknown[]) : [];
  const error = listed ? secureListError(secure, root, strings(storage.keys), platform) : undefined;
  // secureAuth is checked even without storage.secure: it may only name secure keys.
  return error ?? secureAuthError(record(storage.secureAuth), secure, platform);
}

/** The module declaration, then each listed key, of a spec that has `storage.secure`. */
function secureListError(
  secure: unknown[],
  root: Raw,
  keys: string[],
  platform: string[],
): PrototypePlatformError | undefined {
  if (!platform.includes("secureStorage")) {
    return {
      path: "storage.secure",
      message: "storage.secure requires secureStorage in requires.platform",
    };
  }
  for (const [index, entry] of secure.entries()) {
    const message = secureKeyError(entry, root, keys);
    if (message) {
      return { path: `storage.secure[${index}]`, message };
    }
  }
  return undefined;
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
    const leaked = typeof key === "string" ? secureKeyFor(key, secure) : undefined;
    if (leaked) {
      return {
        path: memberPath(`${path}.context`, name),
        message: `Secure storage key ${leaked} cannot be sent in an emit context`,
      };
    }
  }
  return undefined;
}

/** Data actions whose `value` may be a `{state}` binding; `removeData` writes no value. */
const DATA_WRITE_TYPES: ReadonlySet<unknown> = new Set([
  "setData",
  "appendData",
  "upsertData",
  "prependData",
]);

/** Refuses action bindings that could expose secure state outside its storage. */
export function prototypeSecureStorageActionError(
  action: Raw,
  path: string,
  root: Raw,
): PrototypePlatformError | undefined {
  if (DATA_WRITE_TYPES.has(action.type)) {
    return (
      dataWriteError(action.value, `${path}.value`, root) ??
      bindingMapError(action.where, `${path}.where`, root, "data actions")
    );
  }
  switch (action.type) {
    case "removeData":
      return bindingMapError(action.where, `${path}.where`, root, "data actions");
    case "emit":
      return prototypeSecureStorageEmitError(action, path, root);
    case "request":
      return prototypeSecureStorageRequestError(action, path, root);
    case "push":
    case "replace":
      return bindingMapError(action.params, `${path}.params`, root, "route params");
    case "setStack":
      return stackPathError(action.path, `${path}.path`, root);
    case "platform":
      return bindingMapError(action.args, `${path}.args`, root, "platform args");
    default:
      return undefined;
  }
}

/** The first `setStack` path entry whose route params bind a secure key. */
function stackPathError(
  entries: unknown,
  path: string,
  root: Raw,
): PrototypePlatformError | undefined {
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const error = bindingMapError(
      record(entry)?.params,
      `${path}[${index}].params`,
      root,
      "route params",
    );
    if (error) {
      return error;
    }
  }
  return undefined;
}

/**
 * A data-write `{state}` value that reads a secure key: the write would copy the secret into `/data`,
 * its change event and, when the target is in `storage.keys`, plaintext storage. `allowSecureInRequest`
 * does not apply.
 */
function dataWriteError(
  value: unknown,
  path: string,
  root: Raw,
): PrototypePlatformError | undefined {
  const key = bindingKey(value, strings(record(root.storage)?.secure));
  return key ? { path, message: `Secure storage key ${key} cannot be written to data` } : undefined;
}

/** Only state bindings are resolved here; literal strings do not expand placeholders. */
function bindingMapError(
  value: unknown,
  path: string,
  root: Raw,
  destination: string,
): PrototypePlatformError | undefined {
  const bindings = record(value) ?? {};
  const secure = strings(record(root.storage)?.secure);
  for (const name of Object.keys(bindings).sort()) {
    const key = bindingKey(bindings[name], secure);
    if (key) {
      return {
        path: memberPath(path, name),
        message: `Secure storage key ${key} cannot be sent in ${destination}`,
      };
    }
  }
  return undefined;
}

/**
 * A `request` that sends a secure key without `allowSecureInRequest: true`: a `{state}` binding in a
 * header, query value or body (a whole body, a form entry or a multipart value), or a `{key}`
 * placeholder in the URL, a header or a query value. Members are checked in sorted order.
 */
export function prototypeSecureStorageRequestError(
  action: Raw,
  path: string,
  root: Raw,
): PrototypePlatformError | undefined {
  const secure = strings(record(root.storage)?.secure);
  if (action.type !== "request" || action.allowSecureInRequest === true || secure.length === 0) {
    return undefined;
  }
  const leak = (value: unknown, at: string): PrototypePlatformError | undefined => {
    const key =
      typeof value === "string" ? placeholderKey(value, secure) : bindingKey(value, secure);
    return key
      ? {
          path: at,
          message: `Secure storage key ${key} cannot be sent in a request without allowSecureInRequest`,
        }
      : undefined;
  };
  const body = record(action.body);
  const members = (value: unknown, at: string) =>
    Object.keys(record(value) ?? {})
      .sort()
      .map((name) => [record(value)![name], memberPath(at, name)] as const);
  const candidates: (readonly [unknown, string])[] = [
    [action.url, `${path}.url`],
    [record(action.where)?.equals, `${path}.where.equals`],
    ...members(action.headers, `${path}.headers`),
    ...members(action.query, `${path}.query`),
    [action.body, `${path}.body`],
    ...members(body?.form, `${path}.body.form`),
    ...(Array.isArray(body?.multipart) ? body.multipart : []).map(
      (part, index) => [record(part)?.value, `${path}.body.multipart[${index}].value`] as const,
    ),
  ];
  for (const [value, at] of candidates) {
    const error = leak(value, at);
    if (error) {
      return error;
    }
  }
  return undefined;
}

/** The secure key a `{state}` value binding reads, a repeat template matching any row. */
function bindingKey(value: unknown, secure: string[]): string | undefined {
  const key = record(value)?.state;
  return typeof key === "string" ? secureKeyFor(key, secure) : undefined;
}

/**
 * The secure key a `{key}` text placeholder names. Every `{...}` group that closes is checked, at
 * every depth: request text resolves an inner `{token}` even when an outer brace never closes
 * (`{{token}`), and a group may hold repeat placeholders, as in `{tok{row.id}}`, which repeat
 * binding turns into `{token}`, so a group is matched as a template whose inner groups may stand
 * for any text.
 */
function placeholderKey(text: string, secure: string[]): string | undefined {
  const open: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "{") {
      open.push(index + 1);
    } else if (text[index] === "}" && open.length > 0) {
      const key = secureKeyFor(text.slice(open.pop(), index), secure);
      if (key) {
        return key;
      }
    }
  }
  return undefined;
}

/**
 * The first secure `state:` key a context state reference can read. A repeat template such as
 * `token_{item.id}` is expanded per row on the device, so each `{...}` placeholder may stand for any
 * text there.
 */
function secureKeyFor(stateKey: string, secure: string[]): string | undefined {
  const literals = stateKey.split(/\{[^}]*\}/);
  return secure.find(
    (entry) => entry.startsWith("state:") && templateMatches(literals, entry.slice(6)),
  );
}

/**
 * Whether `key` fits the literal parts of a template whose gaps match any text. Linear: the first and
 * last literals anchor the ends and each middle literal is found left to right, so no backtracking.
 */
function templateMatches(literals: string[], key: string): boolean {
  const first = literals[0] ?? "";
  if (literals.length === 1) {
    return key === first;
  }
  const last = literals.at(-1) ?? "";
  const end = key.length - last.length;
  if (end < first.length || !key.startsWith(first) || !key.endsWith(last)) {
    return false;
  }
  let at = first.length;
  for (const part of literals.slice(1, -1)) {
    const found = key.indexOf(part, at);
    if (found < 0 || found + part.length > end) {
      return false;
    }
    at = found + part.length;
  }
  return true;
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
