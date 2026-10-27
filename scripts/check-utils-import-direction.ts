import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { sortedReaddirEntriesSync } from "../src/utils/io";

const SOURCE_ROOT = "src/utils";
const ALLOWED_TIERS = new Set(["utils", "devices", "ctrlProxy", "models", "constants", "config"]);

interface Violation {
  readonly file: string;
  readonly target: string;
}

// `sourceFiles` and `relative` yield OS separators (backslashes on Windows), but
// edges are reported with forward slashes; normalize both edge paths to match.
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\r/g, "");
}

export function sourceFiles(directory: string): string[] {
  return sortedReaddirEntriesSync(directory).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : entry.isFile() && file.endsWith(".ts")
        ? [file]
        : [];
  });
}

/** Every relative import/export/require/dynamic-import target in `file`, as a `src/...` path sans extension. */
export function relativeImportTargets(file: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const targets: string[] = [];

  const record = (specifier: string): void => {
    if (!specifier.startsWith(".")) {
      return;
    }
    targets.push(
      relative(process.cwd(), resolve(dirname(file), specifier)).replace(
        /\.(?:d\.ts|[cm]?[jt]sx?|json)$/,
        "",
      ),
    );
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
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      record(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return targets;
}

function findViolations(file: string): Violation[] {
  return relativeImportTargets(file)
    .filter((target) => {
      const [root, tier] = target.split(/[\\/]/);
      return root !== "src" || !ALLOWED_TIERS.has(tier);
    })
    .map((target) => ({ file, target }));
}

if (import.meta.main) {
  const edges = new Set(
    sourceFiles(SOURCE_ROOT)
      .flatMap(findViolations)
      .map(({ file, target }) => `${toPosixPath(file)} -> ${toPosixPath(target)}`),
  );
  if (edges.size > 0) {
    console.error("error: utils import direction violations:");
    for (const edge of [...edges].sort()) {
      console.error(edge);
    }
    process.exit(1);
  }
  console.log("utils-import-direction: no upward imports.");
}
