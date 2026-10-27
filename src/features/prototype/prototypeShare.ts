import { resolvePrototypeDataPointer, isPrototypeDataPointer } from "./prototypeData";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { record, renderScalar, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";
import { prototypeShareArgumentsError } from "./prototypeShareValidation";
export { prototypeShareArgumentsError } from "./prototypeShareValidation";
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const issue = (path: string, message: string): PrototypePlatformError => ({ path, message });

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
  return text.replace(/\{([^{}]*)\}/g, (original, token: string) =>
    bindToken(original, token, inputs),
  );
}
function bindToken(original: string, token: string, inputs: PrototypeShareInputs): string {
  if (token.startsWith("data:") && isPrototypeDataPointer(token.slice(5))) {
    return scalar(resolvePrototypeDataPointer(inputs.data, token.slice(5))) ?? "";
  }
  if (token === "index") {
    return inputs.index === undefined ? original : String(inputs.index);
  }
  if (token.startsWith("item.") && prototypeContractPatterns.stateKey.test(token.slice(5))) {
    return bindItemToken(original, token, inputs);
  }
  return bindStateToken(original, token, inputs);
}
function bindStateToken(original: string, token: string, inputs: PrototypeShareInputs): string {
  return prototypeContractPatterns.stateKey.test(token) && Object.hasOwn(inputs.state ?? {}, token)
    ? (scalar(inputs.state?.[token]) ?? original)
    : original;
}

function bindItemToken(original: string, token: string, inputs: PrototypeShareInputs): string {
  return scalar(inputs.item?.[token.slice(5)]) ?? original;
}
function bindStrings(value: unknown, inputs: PrototypeShareInputs): unknown {
  if (typeof value === "string") {
    return bindShareText(value, inputs);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => bindStrings(entry, inputs));
  }
  const form = record(value);
  if (form) {
    return Object.fromEntries(
      Object.entries(form).map(([key, entry]) => [key, bindStrings(entry, inputs)]),
    );
  }
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
    if (Object.hasOwn(contact, field!)) {
      lines.push(`${label}:${escape(String(contact[field!]))}`);
    }
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
  if (staticError) {
    return failure(staticError);
  }
  const resolved: Raw = {};
  for (const name of Object.keys(args).sort()) {
    let value = resolveBinding(record(args[name]) ?? {}, inputs);
    if (value === undefined) {
      return failure(issue(`args.${name}`, "Share binding is missing"));
    }
    value = bindStrings(value, inputs);
    if (name === "images" && Array.isArray(value)) {
      value = value.map((entry) => {
        const form = record(entry);
        return typeof form?.data === "string"
          ? resolvePrototypeDataPointer(inputs.data, form.data)
          : entry;
      });
    }
    resolved[name] = value;
  }
  const error = prototypeShareArgumentsError(
    resolved,
    "args",
    new Set(Object.keys(inputs.assets)),
    true,
  );
  if (error) {
    return failure(error);
  }
  return shareResult(resolved, inputs);
}

function resolveBinding(binding: Raw, inputs: PrototypeShareInputs): unknown {
  if (Object.hasOwn(binding, "value")) {
    return binding.value;
  }
  if (typeof binding.state === "string") {
    return Object.hasOwn(inputs.state ?? {}, binding.state)
      ? inputs.state?.[binding.state]
      : undefined;
  }
  if (typeof binding.data === "string") {
    return resolvePrototypeDataPointer(inputs.data, binding.data);
  }
  if (typeof binding.item === "string") {
    return Object.hasOwn(inputs.item ?? {}, binding.item) ? inputs.item?.[binding.item] : undefined;
  }
  if (binding.index === true) {
    return inputs.index;
  }
  return resolvePointerBinding(binding, inputs);
}
function resolvePointerBinding(binding: Raw, inputs: PrototypeShareInputs): unknown {
  for (const name of ["platform", "event"] as const) {
    if (typeof binding[name] === "string") {
      return resolvePrototypeDataPointer(inputs[name], binding[name]);
    }
  }
  return undefined;
}

function shareResult(resolved: Raw, inputs: PrototypeShareInputs): PrototypeShareResolution {
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
  for (const name of ["text", "url", "subject"]) {
    if (typeof resolved[name] === "string") {
      payload[name] = resolved[name];
      items[name] = name === "text" ? [...resolved[name]].slice(0, 2048).join("") : resolved[name];
    }
  }
  if (resolved.contact) {
    payload.vCard = vCard(record(resolved.contact)!);
  }
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
