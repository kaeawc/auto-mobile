import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SOURCE_ROOT = "src";
const OWNER = "src/utils/media/FfmpegClient.ts";
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const CHILD_PROCESS_FUNCTIONS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(file);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [file] : [];
  });
}

function isFfmpegPath(value: string): boolean {
  return /(^|[/\\])ffmpeg(?:\.exe)?$/i.test(value) || /^ffmpeg(?:\.exe)?$/i.test(value);
}

function findViolations(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
  if (!/ffmpeg/i.test(source)) {
    return [];
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const childProcessNamespaces = new Set<string>();
  const childProcessFunctions = new Set<string>();
  const ffmpegBinaries = new Set<string>();
  const violations: Violation[] = [];

  const isFfmpegExpression = (expression: ts.Expression | undefined): boolean => {
    if (!expression) {
      return false;
    }
    if (ts.isStringLiteralLike(expression)) {
      return isFfmpegPath(expression.text);
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text.toLowerCase().includes("ffmpeg")
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return isFfmpegExpression(expression.left) || isFfmpegExpression(expression.right);
    }
    return ts.isIdentifier(expression) && ffmpegBinaries.has(expression.text);
  };

  const isChildProcessRequire = (expression: ts.Expression | undefined): boolean =>
    !!expression &&
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]) &&
    CHILD_PROCESS_MODULES.has(expression.arguments[0].text);

  const isChildProcessLaunch = (expression: ts.LeftHandSideExpression): boolean =>
    (ts.isIdentifier(expression) && childProcessFunctions.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) &&
      CHILD_PROCESS_FUNCTIONS.has(expression.name.text) &&
      ts.isIdentifier(expression.expression) &&
      childProcessNamespaces.has(expression.expression.text));

  const launcherName = (expression: ts.LeftHandSideExpression): string | null => {
    if (ts.isIdentifier(expression) && childProcessFunctions.has(expression.text)) {
      return expression.text;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      childProcessNamespaces.has(expression.expression.text)
    ) {
      return expression.name.text;
    }
    return null;
  };

  const isFfmpegCommand = (expression: ts.Expression | undefined): boolean => {
    if (!expression) {
      return false;
    }
    const text = ts.isStringLiteralLike(expression)
      ? expression.text
      : ts.isTemplateExpression(expression)
        ? expression.head.text
        : "";
    return /(^|[\s;|&])(?:[^\s]*[/\\])?ffmpeg(?:\.exe)?(?:\s|$)/i.test(text);
  };

  const isShellBinary = (expression: ts.Expression | undefined): boolean =>
    !!expression &&
    ts.isStringLiteralLike(expression) &&
    ["sh", "/bin/sh", "bash", "/bin/bash", "cmd", "cmd.exe"].includes(expression.text);

  const hasFfmpegShellArgument = (expression: ts.Expression | undefined): boolean =>
    !!expression &&
    ts.isArrayLiteralExpression(expression) &&
    expression.elements.some((element) => ts.isExpression(element) && isFfmpegCommand(element));

  const isBunSpawn = (expression: ts.LeftHandSideExpression): boolean =>
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Bun" &&
    expression.name.text === "spawn";

  const record = (node: ts.CallExpression): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file,
      line: line + 1,
      column: character + 1,
      text: node.getText(sourceFile),
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        childProcessNamespaces.add(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          if (CHILD_PROCESS_FUNCTIONS.has(imported)) {
            childProcessFunctions.add(specifier.name.text);
          }
        }
      }
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      CHILD_PROCESS_MODULES.has(node.moduleReference.expression.text)
    ) {
      childProcessNamespaces.add(node.name.text);
    }

    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && isChildProcessRequire(node.initializer)) {
        childProcessNamespaces.add(node.name.text);
      }
      if (ts.isObjectBindingPattern(node.name) && isChildProcessRequire(node.initializer)) {
        for (const element of node.name.elements) {
          const imported =
            element.propertyName?.getText(sourceFile) ?? element.name.getText(sourceFile);
          if (ts.isIdentifier(element.name) && CHILD_PROCESS_FUNCTIONS.has(imported)) {
            childProcessFunctions.add(element.name.text);
          }
        }
      }
      if (ts.isIdentifier(node.name) && isFfmpegExpression(node.initializer)) {
        ffmpegBinaries.add(node.name.text);
      }
      if (
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isPropertyAccessExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        childProcessNamespaces.has(node.initializer.expression.text) &&
        CHILD_PROCESS_FUNCTIONS.has(node.initializer.name.text)
      ) {
        childProcessFunctions.add(node.name.text);
      }
    }

    if (ts.isCallExpression(node)) {
      if (isChildProcessLaunch(node.expression)) {
        const launcher = launcherName(node.expression);
        if (
          isFfmpegExpression(node.arguments[0]) ||
          ((launcher === "exec" || launcher === "execSync") &&
            isFfmpegCommand(node.arguments[0])) ||
          (isShellBinary(node.arguments[0]) && hasFfmpegShellArgument(node.arguments[1]))
        ) {
          record(node);
        }
      }
      if (
        isBunSpawn(node.expression) &&
        ts.isArrayLiteralExpression(node.arguments[0]) &&
        isFfmpegExpression(node.arguments[0].elements[0] as ts.Expression | undefined)
      ) {
        record(node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

const violations = sourceFiles(SOURCE_ROOT)
  .filter((file) => file !== OWNER)
  .flatMap(findViolations);

if (violations.length > 0) {
  console.error("error: FFmpeg execution must use src/utils/media/FfmpegClient.ts:");
  for (const violation of violations) {
    console.error(
      `${relative(SOURCE_ROOT, violation.file)}:${violation.line}:${violation.column}: ${violation.text}`,
    );
  }
  process.exit(1);
}

console.log("ffmpeg-execution-boundary: no direct production FFmpeg invocations.");
