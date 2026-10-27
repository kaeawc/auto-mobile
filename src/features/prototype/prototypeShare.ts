import { isPrototypeDataPointer, resolvePrototypeDataPointer } from "./prototypeData";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { record, renderScalar, type Raw } from "./prototypeTemplate";
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
  if (!start || /[\u0000-\u0020\u007f-\u00a0\u2028-\u202e\u2066-\u2069\\]/.test(text)) return false;
  const candidate = dynamic ? maskTemplate(text, "1") : text;
  const authority = candidate.slice(start).split(/[/?#]/, 1)[0]!;
  if (!authority || /[@{}<>^|%]/.test(authority)) return false;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return false;
    const address = authority.slice(1, end);
    const halves = address.split("::");
    const groups = halves.flatMap((half) => (half ? half.split(":") : []));
    if (
      halves.length > 2 ||
      groups.some((group) => !/^[0-9A-Fa-f]{1,4}$(?![\s\S])/.test(group)) ||
      (halves.length === 1 ? groups.length !== 8 : groups.length >= 8)
    )
      return false;
    const tail = authority.slice(end + 1);
    if (tail && !tail.startsWith(":")) return false;
    port = tail ? tail.slice(1) : undefined;
  } else {
    const parts = authority.split(":");
    if (parts.length > 2 || !parts[0] || /[\[\]]/.test(parts[0])) return false;
    port = parts[1];
  }
  return (
    port === undefined ||
    port === "" ||
    (/^[0-9]{1,5}$(?![\s\S])/.test(port) && Number(port) <= 65535)
  );
}

function textError(value: unknown, path: string): PrototypePlatformError | undefined {
  if (typeof value !== "string") return issue(path, "Expected share string");
  if (bytes(value) > MAX_PROTOTYPE_SHARE_TEXT_BYTES)
    return issue(path, "Share string exceeds 65536 UTF-8 bytes");
  return undefined;
}
function assetError(
  value: unknown,
  path: string,
  dynamic: boolean,
  assets?: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  const form = record(value);
  if (dynamic && form && Object.keys(form).length === 1 && isPrototypeDataPointer(form.data))
    return undefined;
  const id =
    typeof value === "string"
      ? value
      : form && Object.keys(form).length === 1
        ? form.asset
        : undefined;
  if (typeof id !== "string" || !id.length || /[{}]/.test(id))
    return issue(path, "Expected uploaded asset id or data binding");
  return assets && !assets.has(id) ? issue(path, "Unknown share asset") : undefined;
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
function valueError(
  name: string,
  value: unknown,
  path: string,
  dynamic: boolean,
  assets?: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  if (["text", "subject", "url"].includes(name)) {
    const error = textError(value, path);
    return (
      error ??
      (name === "url" && value !== "" && !validURL(String(value), dynamic)
        ? issue(path, "Share URL must be absolute http(s) with a literal scheme")
        : undefined)
    );
  }
  if (name === "contact") {
    const form = record(value);
    if (!form) return issue(path, "Expected share contact object");
    for (const key of [...new Set([...Object.keys(form), "name"])].sort()) {
      const at = member(path, key);
      if (!contactNames.includes(key)) return issue(at, "Unknown contact field");
      if (!Object.hasOwn(form, key)) return issue(at, "Required contact name");
      const error = textError(form[key], at);
      if (error) return error;
      if (key === "name" && prototypeContractPatterns.blankText.test(String(form[key])))
        return issue(at, "Required contact name");
      if (key === "url" && !validURL(String(form[key]), dynamic))
        return issue(at, "Share URL must be absolute http(s) with a literal scheme");
    }
    return undefined;
  }
  if (!Array.isArray(value)) return issue(path, "Expected share array");
  const max = name === "images" ? MAX_PROTOTYPE_SHARE_IMAGES : MAX_PROTOTYPE_SHARE_FILES;
  if (value.length < 1 || value.length > max)
    return issue(path, `Share ${name} must contain 1 to ${max} items`);
  for (const [index, entry] of value.entries()) {
    const at = `${path}[${index}]`;
    if (name === "images") {
      const error = assetError(entry, at, dynamic, assets);
      if (error) return error;
      continue;
    }
    const file = record(entry);
    if (!file) return issue(at, "Expected share file object");
    for (const key of [...new Set([...Object.keys(file), "asset", "mimeType", "name"])].sort()) {
      const field = member(at, key);
      if (!["asset", "mimeType", "name"].includes(key)) return issue(field, "Unknown file field");
      if (key === "asset") {
        const error = assetError(file[key], field, false, assets);
        if (error) return error;
      } else if (key === "mimeType") {
        if (dynamic && typeof file[key] === "string" && maskTemplate(file[key]) !== file[key])
          continue;
        if (typeof file[key] !== "string" || !mimeToken.test(file[key]))
          return issue(field, "Share mimeType must be a type/subtype token");
      } else {
        const fileName =
          typeof file[key] === "string" && dynamic ? maskTemplate(file[key]) : file[key];
        if (
          typeof fileName !== "string" ||
          !fileName.length ||
          fileName.startsWith(".") ||
          /[/\\\u0000-\u001f\u007f-\u00a0\u2028-\u202e\u2066-\u2069]/.test(fileName) ||
          bytes(fileName) > 128
        ) {
          return issue(
            field,
            "Share file name must be 1 to 128 UTF-8 bytes, with no leading dot, separators or controls",
          );
        }
      }
    }
  }
  return undefined;
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
    if (!names.includes(name))
      return issue(at, name === "title" ? "Unknown argument: use subject" : "Unknown argument");
    const binding = record(args[name]);
    if (!resolved && (!binding || !Object.hasOwn(binding, "value"))) continue;
    const error = valueError(
      name,
      resolved ? args[name] : binding!.value,
      resolved ? at : `${at}.value`,
      !resolved,
      assets,
    );
    if (error) return error;
  }
  if (
    !["text", "url", "images", "files", "contact"].some((name) => {
      if (!Object.hasOwn(args, name)) return false;
      const binding = record(args[name]);
      if (!resolved && (!binding || !Object.hasOwn(binding, "value"))) return true;
      const value = resolved ? args[name] : binding!.value;
      return typeof value !== "string" || !prototypeContractPatterns.blankText.test(value);
    })
  )
    return issue(path, "Share requires text, url, images, files or contact");
  return undefined;
}

export interface PrototypeShareInputs {
  state?: Raw;
  data?: unknown;
  item?: Raw;
  index?: number;
  platform?: unknown;
  event?: unknown;
  /** Complete uploaded inventory; bytes are transport metadata, never file contents. */
  assets: Readonly<Record<string, { bytes: number }>>;
  outcome?: "shared" | "unknown";
  target?: string;
}
export type PrototypeShareResolution =
  | { ok: true; payload: Raw; summary: Raw }
  | { ok: false; error: { code: "invalid_args"; path: string; message: string } };

const scalar = (value: unknown): string | undefined =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value))
    ? renderScalar(value)
    : undefined;

/** One pass: substitutions never become a second template. Unknown state/item stays literal;
 * missing or non-scalar data reads become empty, matching ordinary prototype text.
 */
function bindShareText(text: string, inputs: PrototypeShareInputs): string {
  return text.replace(/\{([^{}]*)\}/g, (original, token: string) => {
    if (token.startsWith("data:") && isPrototypeDataPointer(token.slice(5)))
      return scalar(resolvePrototypeDataPointer(record(inputs.data), token.slice(5))) ?? "";
    if (token === "index") return inputs.index === undefined ? original : String(inputs.index);
    if (token.startsWith("item.") && prototypeContractPatterns.stateKey.test(token.slice(5)))
      return scalar(inputs.item?.[token.slice(5)]) ?? original;
    return prototypeContractPatterns.stateKey.test(token) &&
      Object.hasOwn(inputs.state ?? {}, token)
      ? (scalar(inputs.state?.[token]) ?? original)
      : original;
  });
}
function bindStrings(value: unknown, inputs: PrototypeShareInputs): unknown {
  if (typeof value === "string") return bindShareText(value, inputs);
  if (Array.isArray(value)) return value.map((entry) => bindStrings(entry, inputs));
  const form = record(value);
  if (form)
    return Object.fromEntries(
      Object.entries(form).map(([key, entry]) => [key, bindStrings(entry, inputs)]),
    );
  return value;
}

/** RFC 2426 TEXT escaping, CRLF and folding at 75 octets without splitting UTF-8 scalars. */
function vCard(contact: Raw): string {
  const escape = (text: string) =>
    text
      .replaceAll("\\", "\\\\")
      .replace(/\r\n|\r|\n/g, "\\n")
      .replaceAll(",", "\\,")
      .replaceAll(";", "\\;");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escape(String(contact.name))}`,
    `N:${escape(String(contact.name))};;;;`,
  ];
  for (const [field, label] of [
    ["phone", "TEL"],
    ["email", "EMAIL"],
    ["org", "ORG"],
    ["url", "URL"],
    ["note", "NOTE"],
  ]) {
    if (Object.hasOwn(contact, field!))
      lines.push(
        `${label}:${field === "url" ? String(contact[field!]) : escape(String(contact[field!]))}`,
      );
  }
  lines.push("END:VCARD");
  return (
    lines
      .map((line) => {
        let out = "",
          column = 0;
        for (const char of line) {
          const size = bytes(char);
          if (column + size > 75) {
            out += "\r\n ";
            column = 1;
          }
          out += char;
          column += size;
        }
        return out;
      })
      .join("\r\n") + "\r\n"
  );
}

/** Pure contract reference, no system sheet, I/O, capability advertisement or simulation. */
export function resolvePrototypeShare(
  args: Raw,
  inputs: PrototypeShareInputs,
): PrototypeShareResolution {
  const failure = (error: PrototypePlatformError): PrototypeShareResolution => ({
    ok: false,
    error: { code: "invalid_args", ...error },
  });
  const staticError = prototypeShareArgumentsError(args, "args");
  if (staticError) return failure(staticError);
  const resolved: Raw = {};
  for (const name of Object.keys(args).sort()) {
    const binding = record(args[name]) ?? {};
    let value: unknown;
    if (Object.hasOwn(binding, "value")) value = binding.value;
    else if (typeof binding.state === "string")
      value = Object.hasOwn(inputs.state ?? {}, binding.state)
        ? inputs.state?.[binding.state]
        : undefined;
    else if (typeof binding.data === "string")
      value = resolvePrototypeDataPointer(record(inputs.data), binding.data);
    else if (typeof binding.item === "string")
      value = Object.hasOwn(inputs.item ?? {}, binding.item)
        ? inputs.item?.[binding.item]
        : undefined;
    else if (binding.index === true) value = inputs.index;
    else if (typeof binding.platform === "string")
      value = resolvePrototypeDataPointer(record(inputs.platform), binding.platform);
    else if (typeof binding.event === "string")
      value = resolvePrototypeDataPointer(record(inputs.event), binding.event);
    if (value === undefined) return failure(issue(`args.${name}`, "Share binding is missing"));
    value = bindStrings(value, inputs);
    if (name === "images" && Array.isArray(value))
      value = value.map((entry) => {
        const form = record(entry);
        return typeof form?.data === "string"
          ? resolvePrototypeDataPointer(record(inputs.data), form.data)
          : entry;
      });
    resolved[name] = value;
  }
  const error = prototypeShareArgumentsError(
    resolved,
    "args",
    new Set(Object.keys(inputs.assets)),
    true,
  );
  if (error) return failure(error);
  for (const name of ["images", "files"]) {
    const entries = (resolved[name] as unknown[] | undefined) ?? [];
    for (const [index, entry] of entries.entries()) {
      const asset = name === "files" ? record(entry)!.asset : entry;
      const assetId = typeof asset === "string" ? asset : (record(asset)!.asset as string);
      const size = record(inputs.assets[assetId])?.bytes;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
        return failure(
          issue(
            `args.${name}[${index}]${name === "files" ? ".asset" : ""}`,
            "Share asset must have non-negative integer bytes",
          ),
        );
    }
  }
  const id = (entry: unknown): string =>
    (typeof entry === "string" ? entry : record(entry)!.asset) as string;
  const images = ((resolved.images as unknown[] | undefined) ?? []).map(id);
  const files = ((resolved.files as Raw[] | undefined) ?? []).map((file) => ({
    name: file.name as string,
    mimeType: file.mimeType as string,
    asset: id(file.asset),
    bytes: inputs.assets[id(file.asset)]!.bytes,
  }));
  const payload: Raw = { images, files };
  const items: Raw = {
    images: images.length,
    files: files.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes })),
    contact: resolved.contact !== undefined,
  };
  for (const name of ["text", "url", "subject"])
    if (typeof resolved[name] === "string") {
      payload[name] = resolved[name];
      items[name] = name === "text" ? [...resolved[name]].slice(0, 2048).join("") : resolved[name];
    }
  if (resolved.contact) payload.vCard = vCard(record(resolved.contact)!);
  return {
    ok: true,
    payload,
    summary: {
      outcome: inputs.outcome ?? "unknown",
      ...(inputs.target === undefined ? {} : { target: inputs.target }),
      items,
    },
  };
}
