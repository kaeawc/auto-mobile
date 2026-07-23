import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/GitMetadataClient.ts";
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const CHILD_PROCESS_FUNCTIONS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.isFile() && file.endsWith(".ts") ? [file] : [];
  });
}

function staticText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return `${node.head.text}${node.templateSpans.map(span => span.literal.text).join("")}`;
  }
  return null;
}

function isGitCommand(node: ts.Expression, shellForm: boolean): boolean {
  const text = staticText(node);
  return text !== null && (shellForm ? /^git(?:\s|$)/.test(text.trimStart()) : text === "git");
}

function isGitArgv(node: ts.Expression | undefined): boolean {
  return !!node && ts.isArrayLiteralExpression(node) && node.elements.length > 0 &&
    ts.isExpression(node.elements[0]) && isGitCommand(node.elements[0], false);
}

function isGitBunSpawn(node: ts.CallExpression): boolean {
  const args = node.arguments;
  if (isGitArgv(args[0])) {
    return true;
  }
  if (!args[0] || !ts.isObjectLiteralExpression(args[0])) {
    return false;
  }
  const command = args[0].properties.find(property =>
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "cmd",
  );
  return !!command && ts.isPropertyAssignment(command) && isGitArgv(command.initializer);
}

function findViolations(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const childProcessFunctions = new Set<string>();
  const childProcessNamespaces = new Set<string>();
  const violations: Violation[] = [];

  const record = (node: ts.CallExpression): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({ file, line: line + 1, column: character + 1, text: node.getText(sourceFile) });
  };

  const isChildProcessCall = (expression: ts.Expression): "shell" | "argv" | null => {
    const name = ts.isIdentifier(expression) ? expression.text :
      ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) &&
        childProcessNamespaces.has(expression.expression.text) ? expression.name.text : null;
    if (!name || !(CHILD_PROCESS_FUNCTIONS.has(name) || childProcessFunctions.has(name))) {
      return null;
    }
    return name === "exec" || name === "execSync" ? "shell" : "argv";
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) { childProcessNamespaces.add(bindings.name.text); }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          if (CHILD_PROCESS_FUNCTIONS.has(imported)) { childProcessFunctions.add(specifier.name.text); }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const kind = isChildProcessCall(node.expression);
      if (kind && node.arguments[0] && isGitCommand(node.arguments[0], kind === "shell")) {
        record(node);
      }
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Bun" && (node.expression.name.text === "spawn" || node.expression.name.text === "spawnSync") &&
        isGitBunSpawn(node)) {
        record(node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

const violations = sourceFiles(SOURCE_ROOT).filter(file => file !== OWNER).flatMap(findViolations);
if (violations.length > 0) {
  console.error("error: production Git metadata execution must use GitMetadataClient:");
  for (const violation of violations) {
    console.error(`${relative(SOURCE_ROOT, violation.file)}:${violation.line}:${violation.column}: ${violation.text}`);
  }
  process.exit(1);
}

console.log("git-metadata-boundary: no direct production Git metadata invocations.");
