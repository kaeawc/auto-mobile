import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src";
const OWNER = join("src", "utils", "ios-cmdline-tools", "PlistClient.ts");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.isFile() && path.endsWith(".ts")
        ? [path]
        : [];
  });
}

const violations = sourceFiles(SOURCE_ROOT).flatMap((file) => {
  if (file === OWNER) {
    return [];
  }
  const source = readFileSync(file, "utf8");
  // Cheap prefilter (issue #5121): a file with no "plutil" substring cannot
  // contain a `plutil` command, so skip parsing it. Superset of the detector's
  // /(?:^|\s)plutil(?:\s|$)/, so it never skips a real violation.
  if (!source.includes("plutil")) {
    return [];
  }
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /(?:^|\s)plutil(?:\s|$)/.test(node.text)
    ) {
      const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      found.push(`${relative(".", file)}:${position.line + 1}:${position.character + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
});

if (violations.length > 0) {
  console.error("Direct production plutil execution must go through PlistClient:");
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  process.exit(1);
}
