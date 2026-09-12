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
 *
 * `<data>` parses to a `Buffer` and `<real>` parses to a {@link PlistReal}
 * wrapper (rather than a bare `number`) so that a round-trip through
 * {@link buildPlist} writes back the same plist type it read — a plain
 * `number` always means `<integer>`. Without the wrapper, an integral
 * `<real>` (e.g. `<real>30</real>`) would satisfy `Number.isInteger` and get
 * rewritten as `<integer>30</integer>`, silently corrupting the type
 * (issue #6372).
 */
export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Buffer
  | PlistReal
  | PlistValue[]
  | Map<string, PlistValue>;

/** Wraps a `<real>` plist value so it round-trips distinctly from `<integer>`. */
export class PlistReal {
  constructor(public readonly value: number) {}
}

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
      return node._ ?? "";
    case "data":
      return node._ ? Buffer.from(node._, "base64") : Buffer.alloc(0);
    case "date":
      return node._ ? new Date(node._) : new Date(0);
    case "integer":
      return node._ ? Number(node._) : 0;
    case "real":
      return new PlistReal(node._ ? Number(node._) : 0);
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

  if (value instanceof PlistReal) {
    return `${pad}<real>${value.value}</real>`;
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
 * Recursively collect every `Map` in `value` (walking into arrays and nested
 * dicts) whose `IsUITestBundle` key is exactly `true`.
 *
 * This makes the walk layout-agnostic: it finds UI-test targets whether they
 * sit at the plist top level (FormatVersion 1, `{ <TargetName>: { ... } }`)
 * or nested under a test-plan configuration array (FormatVersion 2,
 * `TestConfigurations[].TestTargets[]`), without needing to branch on
 * `__xctestrun_metadata__.FormatVersion`.
 */
const collectUITestTargets = (value: PlistValue): Map<string, PlistValue>[] => {
  if (Array.isArray(value)) {
    return value.flatMap((child) => collectUITestTargets(child));
  }

  if (!(value instanceof Map)) {
    return [];
  }

  const targets: Map<string, PlistValue>[] = [];
  if (value.get("IsUITestBundle") === true) {
    targets.push(value);
  }
  for (const child of value.values()) {
    targets.push(...collectUITestTargets(child));
  }
  return targets;
};

/**
 * Merge `env` (string key/value pairs) into the `EnvironmentVariables` dict of
 * every test target in `root` that is a UI-test bundle (`IsUITestBundle` true),
 * regardless of whether it sits at the plist top level (FormatVersion 1) or
 * nested under `TestConfigurations[].TestTargets[]` (FormatVersion 2 — the
 * layout `xcodebuild` emits when the scheme resolves a test plan).
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
  const targets = collectUITestTargets(root);

  for (const target of targets) {
    let envDict = target.get("EnvironmentVariables");
    if (!(envDict instanceof Map)) {
      envDict = new Map<string, PlistValue>();
      target.set("EnvironmentVariables", envDict);
    }

    for (const [key, val] of Object.entries(env)) {
      (envDict as Map<string, PlistValue>).set(key, val);
    }
  }

  return targets.length;
};
