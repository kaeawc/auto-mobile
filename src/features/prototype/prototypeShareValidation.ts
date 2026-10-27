import { isPrototypeDataPointer } from "./prototypeData";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";
import {
  MAX_PROTOTYPE_SHARE_TEXT_BYTES,
  MAX_PROTOTYPE_SHARE_IMAGES,
  MAX_PROTOTYPE_SHARE_FILES,
} from "./prototypeShareLimits";

const names = ["contact", "files", "images", "subject", "text", "url"];
const contactNames = ["email", "name", "note", "org", "phone", "url"];
const issue = (path: string, message: string): PrototypePlatformError => ({ path, message });
const member = (path: string, key: string): string =>
  prototypeContractPatterns.pathKey.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const mimeToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$(?![\s\S])/;

/** A literal http(s) scheme; placeholders elsewhere are revalidated after resolution.
 * A conservative portable URL grammar avoids platform URL parsers disagreeing or repairing input.
 */
function validURL(text: string, dynamic = false): boolean {
  const start = text.match(/^https?:\/\//i)?.[0].length;
  if (!start || /[\u0000-\u0020\u007f-\u00a0\u2028-\u202e\u2066-\u2069\\]/.test(text)) {
    return false;
  }
  const candidate = dynamic ? maskTemplate(text, "1") : text;
  const authority = candidate.slice(start).split(/[/?#]/, 1)[0]!;
  if (!authority || /[{}<>^|%@]/.test(authority)) {
    return false;
  }
  const endpoint = authority.startsWith("[") ? ipv6Port(authority) : hostPort(authority);
  return endpoint.valid && validPort(endpoint.port);
}

function validPort(port: string | undefined): boolean {
  return (
    port === undefined ||
    port === "" ||
    (/^[0-9]{1,5}$(?![\s\S])/.test(port) && Number(port) <= 65535)
  );
}

function hostPort(authority: string): { valid: boolean; port?: string } {
  const parts = authority.split(":");
  return { valid: parts.length <= 2 && !!parts[0] && !/[\[\]]/.test(parts[0]), port: parts[1] };
}

function ipv6Port(authority: string): { valid: boolean; port?: string } {
  const end = authority.indexOf("]");
  if (end < 0) {
    return { valid: false };
  }
  const halves = authority.slice(1, end).split("::");
  const groups = halves.flatMap((half) => (half ? half.split(":") : []));
  const validAddress =
    halves.length <= 2 &&
    groups.every((group) => /^[0-9A-Fa-f]{1,4}$(?![\s\S])/.test(group)) &&
    (halves.length === 1 ? groups.length === 8 : groups.length < 8);
  const tail = authority.slice(end + 1);
  return {
    valid: validAddress && (!tail || tail.startsWith(":")),
    port: tail ? tail.slice(1) : undefined,
  };
}

function textError(value: unknown, path: string): PrototypePlatformError | undefined {
  if (typeof value !== "string") {
    return issue(path, "Expected share string");
  }
  if (bytes(value) > MAX_PROTOTYPE_SHARE_TEXT_BYTES) {
    return issue(path, "Share string exceeds 65536 UTF-8 bytes");
  }
  return undefined;
}
function assetError(
  value: unknown,
  path: string,
  dynamic: boolean,
  assets?: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  const form = record(value);
  if (dynamic && form && Object.keys(form).length === 1 && isPrototypeDataPointer(form.data)) {
    return undefined;
  }
  const id = assetId(value);
  if (typeof id !== "string" || !id.length || /[{}]/.test(id)) {
    return issue(path, "Expected uploaded asset id or data binding");
  }
  return assets && !assets.has(id) ? issue(path, "Unknown share asset") : undefined;
}
function assetId(value: unknown): unknown {
  if (typeof value === "string") {
    return value;
  }
  const form = record(value);
  return form && Object.keys(form).length === 1 ? form.asset : undefined;
}
function maskTemplate(text: string, replacement = "x"): string {
  return text.replace(/\{([^{}]*)\}/g, (original, token: string) =>
    prototypeContractPatterns.stateKey.test(token) ||
    (token.split(".").length === 2 &&
      token.split(".").every((part) => prototypeContractPatterns.stateKey.test(part))) ||
    (token.startsWith("data:") && isPrototypeDataPointer(token.slice(5)))
      ? replacement
      : original,
  );
}
function stringError(
  name: string,
  value: unknown,
  path: string,
  dynamic: boolean,
): PrototypePlatformError | undefined {
  return (
    textError(value, path) ??
    (name === "url" && value !== "" && !validURL(String(value), dynamic)
      ? issue(path, "Share URL must be absolute http(s) with a literal scheme")
      : undefined)
  );
}

function contactError(
  value: unknown,
  path: string,
  dynamic: boolean,
): PrototypePlatformError | undefined {
  const form = record(value);
  if (!form) {
    return issue(path, "Expected share contact object");
  }
  for (const key of [...new Set([...Object.keys(form), "name"])].sort()) {
    const at = member(path, key);
    if (!contactNames.includes(key)) {
      return issue(at, "Unknown contact field");
    }
    if (!Object.hasOwn(form, key)) {
      return issue(at, "Required contact name");
    }
    const error = textError(form[key], at);
    if (error) {
      return error;
    }
    if (key === "name" && prototypeContractPatterns.blankText.test(String(form[key]))) {
      return issue(at, "Required contact name");
    }
    if (key === "url" && !validURL(String(form[key]), dynamic)) {
      return issue(at, "Share URL must be absolute http(s) with a literal scheme");
    }
  }
  return undefined;
}

function fileNameError(
  value: unknown,
  path: string,
  dynamic: boolean,
): PrototypePlatformError | undefined {
  const name = typeof value === "string" && dynamic ? maskTemplate(value) : value;
  return typeof name !== "string" ||
    !name.length ||
    name.startsWith(".") ||
    /[/\\\u0000-\u001f\u007f-\u00a0\u2028-\u202e\u2066-\u2069]/.test(name) ||
    bytes(name) > 128
    ? issue(
        path,
        "Share file name must be 1 to 128 UTF-8 bytes, with no leading dot, separators or controls",
      )
    : undefined;
}

function mimeError(
  value: unknown,
  path: string,
  dynamic: boolean,
): PrototypePlatformError | undefined {
  if (dynamic && typeof value === "string" && maskTemplate(value) !== value) {
    return undefined;
  }
  return typeof value !== "string" || !mimeToken.test(value)
    ? issue(path, "Share mimeType must be a type/subtype token")
    : undefined;
}

function fileError(
  value: unknown,
  path: string,
  dynamic: boolean,
  assets?: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  const file = record(value);
  if (!file) {
    return issue(path, "Expected share file object");
  }
  for (const key of [...new Set([...Object.keys(file), "asset", "mimeType", "name"])].sort()) {
    const at = member(path, key);
    if (!["asset", "mimeType", "name"].includes(key)) {
      return issue(at, "Unknown file field");
    }
    const error =
      key === "asset"
        ? assetError(file[key], at, false, assets)
        : key === "mimeType"
          ? mimeError(file[key], at, dynamic)
          : fileNameError(file[key], at, dynamic);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function arrayError(
  name: string,
  value: unknown,
  path: string,
  dynamic: boolean,
  assets?: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  if (!Array.isArray(value)) {
    return issue(path, "Expected share array");
  }
  const max = name === "images" ? MAX_PROTOTYPE_SHARE_IMAGES : MAX_PROTOTYPE_SHARE_FILES;
  if (value.length < 1 || value.length > max) {
    return issue(path, `Share ${name} must contain 1 to ${max} items`);
  }
  for (const [index, entry] of value.entries()) {
    const at = `${path}[${index}]`;
    const error =
      name === "images"
        ? assetError(entry, at, dynamic, assets)
        : fileError(entry, at, dynamic, assets);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function valueError(
  name: string,
  value: unknown,
  path: string,
  dynamic: boolean,
  assets?: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  if (["text", "subject", "url"].includes(name)) {
    return stringError(name, value, path, dynamic);
  }
  return name === "contact"
    ? contactError(value, path, dynamic)
    : arrayError(name, value, path, dynamic, assets);
}

/** Additional share semantics after the platform table has checked argument names and bindings.
 * Unknown assets can be refused when the caller has a complete uploaded-asset inventory.
 */
export function prototypeShareArgumentsError(
  args: Raw,
  path: string,
  assets?: ReadonlySet<string>,
  resolved = false,
): PrototypePlatformError | undefined {
  for (const name of Object.keys(args).sort()) {
    const at = member(path, name);
    if (!names.includes(name)) {
      return issue(at, name === "title" ? "Unknown argument: use subject" : "Unknown argument");
    }
    const binding = record(args[name]);
    if (!resolved && (!binding || !Object.hasOwn(binding, "value"))) {
      continue;
    }
    const error = valueError(
      name,
      resolved ? args[name] : binding!.value,
      resolved ? at : `${at}.value`,
      !resolved,
      assets,
    );
    if (error) {
      return error;
    }
  }
  if (
    !["text", "url", "images", "files", "contact"].some((name) => {
      if (!Object.hasOwn(args, name)) {
        return false;
      }
      const binding = record(args[name]);
      if (!resolved && (!binding || !Object.hasOwn(binding, "value"))) {
        return true;
      }
      const value = resolved ? args[name] : binding!.value;
      return typeof value !== "string" || !prototypeContractPatterns.blankText.test(value);
    })
  ) {
    return issue(path, "Share requires text, url, images, files or contact");
  }
  return undefined;
}
