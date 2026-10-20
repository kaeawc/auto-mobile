/**
 * MCP SDK / stateless-session boundary guard (issue #4678, slice H phase 1).
 *
 * Fails on:
 *   - any import/export-from/dynamic import/require of `@modelcontextprotocol/sdk` (v1) in src/, scripts/ and test/
 *   - any `require("@modelcontextprotocol/...")` in src/, scripts/ and test/
 *   - any import of the retired `v1ViewMcpClient` test helper (use the plain v2 `Client`)
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
  | "v1-view-client"
  | "mcp-session-id"
  | "sessionIdGenerator"
  | "onsessioninitialized"
  | "sessionContext.sessionId";

export type Counts = Record<string, Partial<Record<RuleId, number>>>;

export const ALLOWLIST_PATH = "scripts/mcp-sdk-boundary-allowlist.json";
/** Import rules cover test/ too: v1 SDK imports only resolve through a parent checkout's node_modules. */
export const IMPORT_ROOTS = ["src", "scripts", "test"];
const TOKEN_ROOT = "src";
const SDK_V1 = /^@modelcontextprotocol\/sdk(?:\/|$)/;
/** The retired test-only v1-error-shape client (test/helpers/v1ViewMcpClient.ts); tests use the plain v2 Client. */
const V1_VIEW_CLIENT = /(?:^|\/)v1View\w*Client(?:\.[cm]?[jt]s)?$/i;
const MCP_SCOPE = /^@modelcontextprotocol\//;
const TOKEN_RULES: ReadonlyArray<readonly [RuleId, RegExp]> = [
  ["mcp-session-id", /(?<!x-auto-mobile-)mcp-session-id/gi],
  ["sessionIdGenerator", /sessionIdGenerator/g],
  ["onsessioninitialized", /onsessioninitialized/gi],
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
  if (!source.includes("@modelcontextprotocol/") && !/v1View\w*Client/i.test(source)) {
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
    if (specifier !== undefined && V1_VIEW_CLIENT.test(specifier)) {
      bump(counts, file, "v1-view-client");
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

/** The property name of `x.name`, `x?.name` and `x["name"]`, or undefined for other accesses. */
function accessedName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

/** True for `sessionContext` as an identifier or as the last member of an access chain. */
function isSessionContext(node: ts.Expression): boolean {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isExpressionWithTypeArguments(inner) ||
    ts.isPartiallyEmittedExpression(inner)
  ) {
    inner = inner.expression;
  }
  return (
    (ts.isIdentifier(inner) && inner.text === "sessionContext") ||
    accessedName(inner) === "sessionContext"
  );
}

/**
 * Count reads of `sessionContext.sessionId` through the parser so `?.`, bracket access and
 * destructuring (`const { sessionId } = x.sessionContext`) cannot dodge a literal-text regex.
 */
export function countSessionContextReads(file: string, source: string, counts: Counts): void {
  if (!source.includes("sessionContext")) {
    return;
  }
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      accessedName(node) === "sessionId" &&
      isSessionContext(node.expression)
    ) {
      bump(counts, file, "sessionContext.sessionId");
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const reads = node.name.elements.some((element) => {
        const key = element.propertyName ?? element.name;
        return (
          (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
          key.text === "sessionId" &&
          node.initializer !== undefined &&
          isSessionContext(node.initializer)
        );
      });
      if (reads) {
        bump(counts, file, "sessionContext.sessionId");
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
  countSessionContextReads(file, source, counts);
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

/** Check-mode exit code: growth and stale (shrinkable) entries both fail. */
export function exitCodeFor({ excess, stale }: Comparison): number {
  return excess.length > 0 || stale.length > 0 ? 1 : 0;
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
    // A stale entry is headroom that lets a violation regrow unnoticed; the ratchet must shrink.
    console.error(
      "error: mcp-sdk-boundary allowlist is stale; shrink it with `bun scripts/check-mcp-sdk-boundary.ts --update`:",
    );
    stale.forEach((line) => console.error(`  ${line}`));
    return 1;
  }
  console.log("mcp-sdk-boundary: no new violations.");
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
