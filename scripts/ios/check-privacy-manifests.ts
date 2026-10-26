/**
 * Guards the iOS privacy manifests of the prototype library and ProtoViewer (#14151).
 *
 * Apple rejects (ITMS-91053) an upload that uses a required-reason API without a matching
 * `NSPrivacyAccessedAPITypes` entry. This check scans the compiled Swift sources for those APIs
 * (comments and string literals removed first) and compares the categories found with the
 * manifest that ships with them:
 *
 *   - `AutoMobilePrototype` library (Sources minus the Package.swift exclusions) is declared by
 *     `ios/prototype-agent/Sources/PrivacyInfo.xcprivacy`;
 *   - ProtoViewer (all Sources plus `ProtoViewer/`) is declared by
 *     `ios/prototype-agent/ProtoViewer/PrivacyInfo.xcprivacy`.
 *
 * A used category needs a manifest entry with at least one valid reason code, an entry for an
 * unused category is stale, and both manifests must declare no tracking and no collected data.
 *
 *   bun scripts/ios/check-privacy-manifests.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStringPromise } from "xml2js";

export interface RequiredReasonCategory {
  /** `NSPrivacyAccessedAPIType` value. */
  readonly key: string;
  /** Swift identifiers that Apple lists for the category. */
  readonly symbols: readonly string[];
  /** Reason codes Apple accepts for the category. */
  readonly reasons: readonly string[];
}

// Apple's "Describing use of required reason API" lists, as of 2026-10.
export const REQUIRED_REASON_CATEGORIES: readonly RequiredReasonCategory[] = [
  {
    key: "NSPrivacyAccessedAPICategoryFileTimestamp",
    symbols: [
      "creationDate",
      "modificationDate",
      "fileModificationDate",
      "fileCreationDate",
      "NSFileCreationDate",
      "NSFileModificationDate",
      "NSURLContentModificationDateKey",
      "NSURLCreationDateKey",
      "contentModificationDateKey",
      "creationDateKey",
      "contentAccessDateKey",
      "getattrlist",
      "getattrlistbulk",
      "fgetattrlist",
      "stat",
      "fstat",
      "fstatat",
      "lstat",
      "attributesOfItem",
    ],
    reasons: ["DDA9.1", "C617.1", "3B52.1", "0A2A.1"],
  },
  {
    key: "NSPrivacyAccessedAPICategorySystemBootTime",
    symbols: ["systemUptime", "mach_absolute_time"],
    reasons: ["35F9.1", "8FFB.1", "3D61.1"],
  },
  {
    key: "NSPrivacyAccessedAPICategoryDiskSpace",
    symbols: [
      "volumeAvailableCapacityKey",
      "volumeAvailableCapacityForImportantUsageKey",
      "volumeAvailableCapacityForOpportunisticUsageKey",
      "volumeTotalCapacityKey",
      "systemFreeSize",
      "systemSize",
      "statfs",
      "statvfs",
      "fstatfs",
      "fstatvfs",
    ],
    reasons: ["85F4.1", "E174.1", "7D9E.1", "B728.1"],
  },
  {
    key: "NSPrivacyAccessedAPICategoryActiveKeyboards",
    symbols: ["activeInputModes"],
    reasons: ["3EC4.1", "54BD.1"],
  },
  {
    key: "NSPrivacyAccessedAPICategoryUserDefaults",
    symbols: ["UserDefaults", "NSUserDefaults", "AppStorage"],
    reasons: ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
  },
];

export interface ApiUsage {
  readonly category: string;
  readonly symbol: string;
  readonly file: string;
  readonly line: number;
}

/** Replaces comments and string-literal contents with spaces, keeping newlines for line numbers. */
export function stripSwiftNonCode(source: string): string {
  const out: string[] = [];
  let i = 0;
  let commentDepth = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const rest = source.slice(i, i + 3);
    if (commentDepth > 0) {
      if (rest.startsWith("/*")) {
        commentDepth += 1;
        out.push("  ");
        i += 2;
      } else if (rest.startsWith("*/")) {
        commentDepth -= 1;
        out.push("  ");
        i += 2;
      } else {
        out.push(blank(source[i]));
        i += 1;
      }
    } else if (rest.startsWith("/*")) {
      commentDepth = 1;
      out.push("  ");
      i += 2;
    } else if (rest.startsWith("//")) {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out.push(blank(source.slice(i, stop)));
      i = stop;
    } else if (rest === '"""') {
      const end = source.indexOf('"""', i + 3);
      const stop = end === -1 ? source.length : end + 3;
      out.push(blank(source.slice(i, stop)));
      i = stop;
    } else if (source[i] === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"' && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      const stop = Math.min(j + 1, source.length);
      out.push(blank(source.slice(i, stop)));
      i = stop;
    } else {
      out.push(source[i]);
      i += 1;
    }
  }
  return out.join("");
}

const SYMBOL_TO_CATEGORY = new Map(
  REQUIRED_REASON_CATEGORIES.flatMap((category) =>
    category.symbols.map((symbol) => [symbol, category.key] as const),
  ),
);

// A bare identifier, optionally module-qualified. `stat` and friends only count as calls
// (`stat()` is the struct initializer, `lstat(path, &info)` the function) and never as a
// member of an unrelated type (`cache.stat(...)`).
const IDENTIFIER = /(?<![\w$])((?:(?:Darwin|Glibc|Foundation)\.)?)([A-Za-z_][A-Za-z0-9_]*)/g;
const CALL_ONLY = new Set(["stat", "fstat", "fstatat", "lstat"]);

/** Finds required-reason API symbols in one Swift file. */
export function findApiUsages(file: string, source: string): ApiUsage[] {
  const code = stripSwiftNonCode(source);
  const usages: ApiUsage[] = [];
  for (const match of code.matchAll(IDENTIFIER)) {
    const symbol = match[2];
    const category = SYMBOL_TO_CATEGORY.get(symbol);
    if (!category) {
      continue;
    }
    const before = code.slice(0, match.index);
    if (CALL_ONLY.has(symbol)) {
      const next = code.slice(match.index + match[0].length).trimStart()[0];
      const member = match[1] === "" && before.trimEnd().endsWith(".");
      if (next !== "(" || member) {
        continue;
      }
    }
    usages.push({ category, symbol, file, line: before.split("\n").length });
  }
  return usages;
}

interface PlistNode {
  "#name": string;
  _?: string;
  $$?: PlistNode[];
}

export type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue };

function nodeValue(node: PlistNode): PlistValue {
  const children = node.$$ ?? [];
  switch (node["#name"]) {
    case "dict": {
      const entries: Array<[string, PlistValue]> = [];
      for (let i = 0; i < children.length; i += 2) {
        const key = children[i];
        const value = children[i + 1];
        if (key?.["#name"] !== "key" || !value) {
          throw new Error("Malformed plist dictionary key/value pair");
        }
        entries.push([(key._ ?? "").trim(), nodeValue(value)]);
      }
      return Object.fromEntries(entries);
    }
    case "array":
      return children.map(nodeValue);
    case "string":
      return (node._ ?? "").trim();
    case "true":
      return true;
    case "false":
      return false;
    default:
      throw new Error(`Unsupported plist tag '${node["#name"]}' in a privacy manifest`);
  }
}

export async function parsePlistDictionary(xml: string): Promise<{ [key: string]: PlistValue }> {
  const parsed: PlistNode = await parseStringPromise(xml, {
    explicitChildren: true,
    preserveChildrenOrder: true,
    explicitRoot: false,
    trim: false,
  });
  const root = parsed["#name"] === "plist" ? parsed.$$?.[0] : undefined;
  if (!root || root["#name"] !== "dict") {
    throw new Error("A privacy manifest must be a plist dictionary");
  }
  const value = nodeValue(root);
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A privacy manifest must be a plist dictionary");
  }
  return value;
}

export interface Declaration {
  readonly category: string;
  readonly reasons: readonly string[];
}

export interface ParsedManifest {
  readonly tracking: unknown;
  readonly trackingDomains: unknown;
  readonly collectedDataTypes: unknown;
  readonly declarations: readonly Declaration[];
}

export async function parsePrivacyManifest(xml: string): Promise<ParsedManifest> {
  const dictionary = await parsePlistDictionary(xml);
  const accessed = dictionary.NSPrivacyAccessedAPITypes;
  const entries = Array.isArray(accessed) ? accessed : [];
  const declarations = entries.map((entry): Declaration => {
    const record = typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const reasons = record.NSPrivacyAccessedAPITypeReasons;
    return {
      category: String(record.NSPrivacyAccessedAPIType ?? ""),
      reasons: Array.isArray(reasons) ? reasons.map(String) : [],
    };
  });
  return {
    tracking: dictionary.NSPrivacyTracking,
    trackingDomains: dictionary.NSPrivacyTrackingDomains,
    collectedDataTypes: dictionary.NSPrivacyCollectedDataTypes,
    declarations,
  };
}

/** Returns the problems of one manifest against the usages of the sources it ships with. */
export function evaluateManifest(
  name: string,
  manifest: ParsedManifest,
  usages: readonly ApiUsage[],
): string[] {
  const problems: string[] = [];
  if (manifest.tracking !== false) {
    problems.push(`${name}: NSPrivacyTracking must be false`);
  }
  if (!Array.isArray(manifest.trackingDomains) || manifest.trackingDomains.length > 0) {
    problems.push(`${name}: NSPrivacyTrackingDomains must be an empty array`);
  }
  if (!Array.isArray(manifest.collectedDataTypes) || manifest.collectedDataTypes.length > 0) {
    problems.push(`${name}: NSPrivacyCollectedDataTypes must be an empty array (collects nothing)`);
  }
  const known = new Map(REQUIRED_REASON_CATEGORIES.map((category) => [category.key, category]));
  const declared = new Map<string, Declaration>();
  for (const declaration of manifest.declarations) {
    if (!known.has(declaration.category)) {
      problems.push(`${name}: unknown API category '${declaration.category}'`);
    } else if (declared.has(declaration.category)) {
      problems.push(`${name}: category ${declaration.category} is declared twice`);
    }
    declared.set(declaration.category, declaration);
  }
  const used = new Set(usages.map((usage) => usage.category));
  for (const category of used) {
    const declaration = declared.get(category);
    const first = usages.find((usage) => usage.category === category);
    const where = first ? `${first.symbol} at ${first.file}:${first.line}` : category;
    if (!declaration) {
      problems.push(`${name}: ${category} is used (${where}) but has no declared reason`);
    } else if (declaration.reasons.length === 0) {
      problems.push(`${name}: ${category} is declared with no reason code`);
    }
  }
  for (const [category, declaration] of declared) {
    const allowed = known.get(category)?.reasons ?? [];
    for (const reason of declaration.reasons) {
      if (allowed.length > 0 && !allowed.includes(reason)) {
        problems.push(`${name}: '${reason}' is not a valid reason for ${category}`);
      }
    }
    if (known.has(category) && !used.has(category)) {
      problems.push(`${name}: ${category} is declared but no compiled source uses it (stale)`);
    }
  }
  return problems;
}

export interface SourceFiles {
  /** Repo-relative path to Swift text. */
  readonly [path: string]: string;
}

// Mirrors the AutoMobilePrototype target `exclude` list in the root Package.swift.
export const LIBRARY_EXCLUDED = [
  "AutoMobilePrototypeAgent/PrototypeAgent.swift",
  "AutoMobilePrototypeAgent/PrototypeServer.swift",
];
export const PATHS = {
  sources: "ios/prototype-agent/Sources",
  app: "ios/prototype-agent/ProtoViewer",
  libraryManifest: "ios/prototype-agent/Sources/PrivacyInfo.xcprivacy",
  appManifest: "ios/prototype-agent/ProtoViewer/PrivacyInfo.xcprivacy",
} as const;

export function scopeUsages(files: SourceFiles): { library: ApiUsage[]; app: ApiUsage[] } {
  const library: ApiUsage[] = [];
  const app: ApiUsage[] = [];
  for (const [path, source] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.endsWith(".swift")) {
      continue;
    }
    const usages = findApiUsages(path, source);
    if (path.startsWith(`${PATHS.sources}/`)) {
      app.push(...usages);
      const inTarget = path.slice(PATHS.sources.length + 1);
      if (!LIBRARY_EXCLUDED.includes(inTarget)) {
        library.push(...usages);
      }
    } else if (path.startsWith(`${PATHS.app}/`)) {
      app.push(...usages);
    }
  }
  return { library, app };
}

export async function checkPrivacyManifests(
  files: SourceFiles,
  manifests: { library: string; app: string },
): Promise<string[]> {
  const usages = scopeUsages(files);
  return [
    ...evaluateManifest(
      "AutoMobilePrototype",
      await parsePrivacyManifest(manifests.library),
      usages.library,
    ),
    ...evaluateManifest("ProtoViewer", await parsePrivacyManifest(manifests.app), usages.app),
  ];
}

function collectSwiftFiles(root: string, directory: string): SourceFiles {
  const files: { [path: string]: string } = {};
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      Object.assign(files, collectSwiftFiles(root, path));
    } else if (entry.name.endsWith(".swift")) {
      files[path] = readFileSync(join(root, path), "utf8");
    }
  }
  return files;
}

export async function main(root: string): Promise<number> {
  try {
    const files = {
      ...collectSwiftFiles(root, PATHS.sources),
      ...collectSwiftFiles(root, PATHS.app),
    };
    const problems = await checkPrivacyManifests(files, {
      library: readFileSync(join(root, PATHS.libraryManifest), "utf8"),
      app: readFileSync(join(root, PATHS.appManifest), "utf8"),
    });
    if (problems.length > 0) {
      console.error(`Privacy manifest check failed:\n${problems.map((p) => `  ${p}`).join("\n")}`);
      console.error(
        "Fix: add or remove the NSPrivacyAccessedAPITypes entry with a reason from Apple's list " +
          "(docs/protoviewer/privacy.md).",
      );
      return 1;
    }
    console.log("Privacy manifests match the required-reason APIs used.");
    return 0;
  } catch (error) {
    console.error(`Privacy manifest check could not run: ${String(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(fileURLToPath(new URL("../../", import.meta.url)));
}
