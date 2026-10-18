/**
 * MCP SDK / stateless-session boundary guard (issue #4678, slice H phase 1).
 *
 * Fails on:
 *   - any import/export-from/dynamic import/require of `@modelcontextprotocol/sdk` (v1) in src/ and scripts/
 *   - any `require("@modelcontextprotocol/...")` in src/ and scripts/
 *   - the stateful-session tokens `mcp-session-id`, `sessionIdGenerator`, `onsessioninitialized`
 *     and `sessionContext.sessionId` under src/
 *
 * Sites that still exist are recorded per file and rule in
 * scripts/mcp-sdk-boundary-allowlist.json. It is a one-way ratchet: a count above the
 * allowlist fails; a count below it is reported as stale so the slice that removed the
 * site shrinks the file (`--update` rewrites it, refusing to grow without `--allow-grow`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { sortedReaddirEntriesSync } from "../src/utils/io";

export type RuleId =
  | "sdk-import"
  | "sdk-require"
  | "mcp-session-id"
  | "sessionIdGenerator"
  | "onsessioninitialized"
  | "sessionContext.sessionId";

export type Counts = Record<string, Partial<Record<RuleId, number>>>;

export const ALLOWLIST_PATH = "scripts/mcp-sdk-boundary-allowlist.json";
const IMPORT_ROOTS = ["src", "scripts"];
const TOKEN_ROOT = "src";
const SDK_V1 = /^@modelcontextprotocol\/sdk(?:\/|$)/;
const MCP_SCOPE = /^@modelcontextprotocol\//;
const TOKEN_RULES: ReadonlyArray<readonly [RuleId, RegExp]> = [
  ["mcp-session-id", /(?<!x-auto-mobile-)mcp-session-id/gi],
  ["sessionIdGenerator", /sessionIdGenerator/g],
  ["onsessioninitialized", /onsessioninitialized/gi],
  ["sessionContext.sessionId", /sessionContext\.sessionId/g],
];

function sourceFiles(directory: string): string[] {
  return sortedReaddirEntriesSync(directory).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(file);
    }
    return entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [file] : [];
  });
}

function bump(counts: Counts, file: string, rule: RuleId, n = 1): void {
  if (n === 0) {
    return;
  }
  const entry = (counts[file] ??= {});
  entry[rule] = (entry[rule] ?? 0) + n;
}

/** Count module-specifier violations using the TypeScript parser (no line regexes). */
export function countImportViolations(file: string, source: string, counts: Counts): void {
  if (!source.includes("@modelcontextprotocol/")) {
    return;
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifierText = (node: ts.Node | undefined): string | undefined =>
    node && ts.isStringLiteralLike(node) ? node.text : undefined;
  const checkStatic = (specifier: string | undefined): void => {
    if (specifier !== undefined && SDK_V1.test(specifier)) {
      bump(counts, file, "sdk-import");
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      checkStatic(specifierText(node.moduleSpecifier));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const spec = specifierText(node.moduleReference.expression);
      checkStatic(spec);
      if (spec !== undefined && MCP_SCOPE.test(spec)) {
        bump(counts, file, "sdk-require");
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      checkStatic(specifierText(node.argument.literal));
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const spec = specifierText(node.arguments[0]);
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "require" && spec !== undefined) {
        if (MCP_SCOPE.test(spec)) {
          bump(counts, file, "sdk-require");
        }
        checkStatic(spec);
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        checkStatic(spec);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export function countTokenViolations(file: string, source: string, counts: Counts): void {
  for (const [rule, pattern] of TOKEN_RULES) {
    bump(counts, file, rule, source.match(pattern)?.length ?? 0);
  }
}

export function scan(
  read: (file: string) => string,
  importFiles: string[],
  tokenFiles: string[],
): Counts {
  const counts: Counts = {};
  for (const file of importFiles) {
    countImportViolations(file, read(file), counts);
  }
  for (const file of tokenFiles) {
    countTokenViolations(file, read(file), counts);
  }
  return counts;
}

export interface Comparison {
  excess: string[];
  stale: string[];
}

export function compare(actual: Counts, allowed: Counts): Comparison {
  const excess: string[] = [];
  const stale: string[] = [];
  const files = new Set([...Object.keys(actual), ...Object.keys(allowed)]);
  for (const file of [...files].sort()) {
    const rules = new Set([
      ...Object.keys(actual[file] ?? {}),
      ...Object.keys(allowed[file] ?? {}),
    ] as RuleId[]);
    for (const rule of [...rules].sort() as RuleId[]) {
      const have = actual[file]?.[rule] ?? 0;
      const limit = allowed[file]?.[rule] ?? 0;
      if (have > limit) {
        excess.push(`${file}: ${rule} x${have} (allowed ${limit})`);
      } else if (have < limit) {
        stale.push(`${file}: ${rule} x${have} (allowlist says ${limit})`);
      }
    }
  }
  return { excess, stale };
}

function normalize(files: string[]): string[] {
  return files.map((f) => f.split(sep).join("/"));
}

function sortedCounts(counts: Counts): Counts {
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((file) => [file, Object.fromEntries(Object.entries(counts[file]).sort())]),
  );
}

function main(argv: string[]): number {
  const read = (file: string): string => readFileSync(file, "utf8");
  const importFiles = normalize(IMPORT_ROOTS.flatMap(sourceFiles));
  const tokenFiles = normalize(sourceFiles(TOKEN_ROOT));
  const actual = scan(read, importFiles, tokenFiles);
  const allowed = JSON.parse(read(ALLOWLIST_PATH)) as Counts;
  const { excess, stale } = compare(actual, allowed);

  if (argv.includes("--update")) {
    if (excess.length > 0 && !argv.includes("--allow-grow")) {
      console.error("error: refusing to grow the MCP SDK boundary allowlist (use --allow-grow):");
      excess.forEach((line) => console.error(`  ${line}`));
      return 1;
    }
    writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(sortedCounts(actual), null, 2)}\n`);
    console.log(`mcp-sdk-boundary: wrote ${ALLOWLIST_PATH}`);
    return 0;
  }

  if (excess.length > 0) {
    console.error(
      "error: MCP SDK / stateful-session boundary violations (see scripts/check-mcp-sdk-boundary.ts):",
    );
    excess.forEach((line) => console.error(`  ${line}`));
    return 1;
  }
  if (stale.length > 0) {
    console.warn(
      "mcp-sdk-boundary: allowlist is stale; shrink it with `bun scripts/check-mcp-sdk-boundary.ts --update`:",
    );
    stale.forEach((line) => console.warn(`  ${line}`));
  }
  console.log("mcp-sdk-boundary: no new violations.");
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
