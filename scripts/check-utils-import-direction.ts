import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { sortedReaddirEntriesSync } from "../src/utils/io";

const SOURCE_ROOT = "src/utils";
const BASELINE = "scripts/utils-import-direction-baseline.txt";
const ALLOWED_TIERS = new Set(["utils", "devices", "ctrlProxy", "models", "constants"]);

interface Violation {
  readonly file: string;
  readonly target: string;
}

// `sourceFiles` and `relative` yield OS separators (backslashes on Windows), but
// the committed baseline uses forward slashes; normalize both edge paths to match.
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\r/g, "");
}

function sourceFiles(directory: string): string[] {
  return sortedReaddirEntriesSync(directory).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : entry.isFile() && file.endsWith(".ts")
        ? [file]
        : [];
  });
}

function findViolations(file: string): Violation[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  const record = (specifier: string): void => {
    if (!specifier.startsWith(".")) {
      return;
    }
    const target = relative(process.cwd(), resolve(dirname(file), specifier)).replace(
      /\.(?:d\.ts|[cm]?[jt]sx?|json)$/,
      "",
    );
    const [root, tier] = target.split(/[\\/]/);
    if (root !== "src" || !ALLOWED_TIERS.has(tier)) {
      violations.push({ file, target });
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

if (import.meta.main) {
  const edges = new Set(
    sourceFiles(SOURCE_ROOT)
      .flatMap(findViolations)
      .map(({ file, target }) => `${toPosixPath(file)} -> ${toPosixPath(target)}`),
  );
  const baseline = new Set(readFileSync(BASELINE, "utf8").split(/\r?\n/).filter(Boolean));
  const newEdges = [...edges].filter((edge) => !baseline.has(edge)).sort();

  if (
    newEdges.length > 0 &&
    !(process.argv.includes("--update") && process.argv.includes("--allow-grow"))
  ) {
    console.error("error: new utils import direction violations:");
    for (const edge of newEdges) {
      console.error(edge);
    }
    process.exit(1);
  }

  if (process.argv.includes("--update")) {
    writeFileSync(
      BASELINE,
      [...edges]
        .sort()
        .map((edge) => `${edge}\n`)
        .join(""),
    );
    console.log(`utils-import-direction: updated baseline (${edges.size} edges).`);
  } else {
    console.log(`utils-import-direction: no new upward imports (${edges.size} existing edges).`);
  }
}
