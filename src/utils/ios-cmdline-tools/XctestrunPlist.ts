import { Parser } from "xml2js";

/**
 * Minimal XML property-list (plist) reader/writer used to edit `.xctestrun`
 * files in place.
 *
 * Dictionaries are represented as `Map<string, PlistValue>` so insertion order
 * is preserved on round-trip (xctestrun ordering is cosmetic but worth keeping)
 * and so callers can `get`/`set` keys ergonomically.
 *
 * Only the plist subset that appears in `.xctestrun` files is supported:
 * dict, array, string, integer, real, true/false, date, data.
 */
export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Buffer
  | PlistValue[]
  | Map<string, PlistValue>;

interface PlistNode {
  "#name": string;
  _?: string;
  $$?: PlistNode[];
}

const plistParser = new Parser({
  explicitChildren: true,
  preserveChildrenOrder: true,
  explicitRoot: false,
});

const nodeToValue = (node: PlistNode | undefined): PlistValue => {
  if (!node) {
    return "";
  }

  switch (node["#name"]) {
    case "dict": {
      const result = new Map<string, PlistValue>();
      const children = node.$$ ?? [];
      for (let i = 0; i < children.length; i += 2) {
        const keyNode = children[i];
        const valueNode = children[i + 1];
        if (!keyNode || keyNode["#name"] !== "key") {
          continue;
        }
        result.set(keyNode._ ?? "", nodeToValue(valueNode));
      }
      return result;
    }
    case "array":
      return (node.$$ ?? []).map((child) => nodeToValue(child));
    case "string":
    case "data":
      return node._ ?? "";
    case "date":
      return node._ ? new Date(node._) : new Date(0);
    case "integer":
    case "real":
      return node._ ? Number(node._) : 0;
    case "true":
      return true;
    case "false":
      return false;
    default:
      return node._ ?? "";
  }
};

/**
 * Parse an XML plist document into a {@link PlistValue}. Dictionaries become
 * ordered `Map`s.
 */
export const parsePlist = async (xml: string): Promise<PlistValue> => {
  const parsed = (await plistParser.parseStringPromise(xml)) as PlistNode;
  const root = parsed["#name"] === "plist" ? parsed.$$?.[0] : parsed;
  return nodeToValue(root);
};

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const indent = (depth: number): string => "\t".repeat(depth);

const valueToXml = (value: PlistValue, depth: number): string => {
  const pad = indent(depth);

  if (value instanceof Map) {
    if (value.size === 0) {
      return `${pad}<dict/>`;
    }
    const lines: string[] = [`${pad}<dict>`];
    for (const [key, child] of value.entries()) {
      lines.push(`${indent(depth + 1)}<key>${escapeXml(key)}</key>`);
      lines.push(valueToXml(child, depth + 1));
    }
    lines.push(`${pad}</dict>`);
    return lines.join("\n");
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${pad}<array/>`;
    }
    const lines: string[] = [`${pad}<array>`];
    for (const child of value) {
      lines.push(valueToXml(child, depth + 1));
    }
    lines.push(`${pad}</array>`);
    return lines.join("\n");
  }

  if (typeof value === "boolean") {
    return `${pad}${value ? "<true/>" : "<false/>"}`;
  }

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${pad}<integer>${value}</integer>`
      : `${pad}<real>${value}</real>`;
  }

  if (value instanceof Date) {
    return `${pad}<date>${value.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`;
  }

  if (Buffer.isBuffer(value)) {
    return `${pad}<data>${value.toString("base64")}</data>`;
  }

  return `${pad}<string>${escapeXml(value)}</string>`;
};

/**
 * Serialize a {@link PlistValue} back to an XML plist document.
 */
export const buildPlist = (value: PlistValue): string => {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    valueToXml(value, 0),
    "</plist>",
    "",
  ].join("\n");
};

/**
 * Merge `env` (string key/value pairs) into the `EnvironmentVariables` dict of
 * every test target in `root` that is a UI-test bundle (`IsUITestBundle` true).
 *
 * Existing keys are overwritten, missing `EnvironmentVariables` dicts are
 * created, and non-UI targets are left untouched.
 *
 * @returns the number of UI-test targets that received the environment.
 */
export const injectUITestEnvironment = (
  root: Map<string, PlistValue>,
  env: Record<string, string>,
): number => {
  let injected = 0;

  for (const value of root.values()) {
    if (!(value instanceof Map) || value.get("IsUITestBundle") !== true) {
      continue;
    }

    let envDict = value.get("EnvironmentVariables");
    if (!(envDict instanceof Map)) {
      envDict = new Map<string, PlistValue>();
      value.set("EnvironmentVariables", envDict);
    }

    for (const [key, val] of Object.entries(env)) {
      (envDict as Map<string, PlistValue>).set(key, val);
    }
    injected += 1;
  }

  return injected;
};
