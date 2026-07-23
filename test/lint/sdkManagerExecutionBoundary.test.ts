import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");
const CLIENT = "src/utils/android-cmdline-tools/SdkManagerClient.ts";
const LAUNCHER_NAMES = new Set([
  "spawn",
  "spawnSync",
  "spawnCommand",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
]);

function directlyExecutesSdkManager(source: string): boolean {
  const lowerSource = source.toLowerCase();
  if (!lowerSource.includes("sdk") || !lowerSource.includes("manager")) {return false;}

  const sourceFile = ts.createSourceFile(
    "sdkmanager-boundary.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const launcherAliases = new Set(LAUNCHER_NAMES);
  const initializers = new Map<string, ts.Expression>();
  const declarations: ts.VariableDeclaration[] = [];

  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      ["child_process", "node:child_process"].includes(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (LAUNCHER_NAMES.has(importedName)) {launcherAliases.add(element.name.text);}
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      if (ts.isIdentifier(node.name) && node.initializer) {
        initializers.set(node.name.text, node.initializer);
      }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const propertyName = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : ts.isIdentifier(element.name) ? element.name.text : undefined;
          if (propertyName && LAUNCHER_NAMES.has(propertyName) && ts.isIdentifier(element.name)) {
            launcherAliases.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const isLauncherReference = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) {return launcherAliases.has(node.text);}
    return ts.isPropertyAccessExpression(node) && LAUNCHER_NAMES.has(node.name.text);
  };
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer ||
        !isLauncherReference(declaration.initializer) || launcherAliases.has(declaration.name.text)) {
        continue;
      }
      launcherAliases.add(declaration.name.text);
      aliasesChanged = true;
    }
  }

  const staticText = (node: ts.Expression): string | undefined => {
    if (ts.isStringLiteralLike(node)) {return node.text;}
    if (ts.isParenthesizedExpression(node)) {return staticText(node.expression);}
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticText(node.left);
      const right = staticText(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  };
  const mentionsSdkManager = (node: ts.Node, seen = new Set<string>()): boolean => {
    if (ts.isExpression(node) && staticText(node)?.toLowerCase().includes("sdkmanager")) {
      return true;
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const initializer = initializers.get(node.text);
      if (initializer) {
        const nextSeen = new Set(seen);
        nextSeen.add(node.text);
        if (mentionsSdkManager(initializer, nextSeen)) {return true;}
      }
    }
    let found = false;
    ts.forEachChild(node, child => {
      if (!found && mentionsSdkManager(child, seen)) {found = true;}
    });
    return found;
  };

  let directExecution = false;
  const inspect = (node: ts.Node): void => {
    if (directExecution) {return;}
    if (ts.isCallExpression(node) && isLauncherReference(node.expression) &&
      node.arguments.some(argument => mentionsSdkManager(argument))) {
      directExecution = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return directExecution;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("sdkmanager execution boundary (issue #4052)", () => {
  test("only SdkManagerClient directly executes sdkmanager", async () => {
    const exceptions = new Map<string, string>([
      // Keep production diagnostics out of this list unless they cannot use the client.
    ]);
    const files = sourceFiles(join(ROOT, "src"));
    const sources = await Promise.all(files.map(async file => ({
      file,
      source: await Bun.file(file).text(),
    })));
    const offenders = sources.flatMap(({ file, source }) => {
      const repoPath = relative(ROOT, file);
      if (repoPath === CLIENT || exceptions.has(repoPath)) {return [];}
      return directlyExecutesSdkManager(source)
        ? [`${repoPath} directly executes sdkmanager; route it through ${CLIENT} instead.`]
        : [];
    });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("detects resolved paths passed to supported launch APIs", () => {
    expect(directlyExecutesSdkManager('const binary = join(root, "bin", "sdkmanager"); execFile(binary, args);')).toBe(true);
    expect(directlyExecutesSdkManager('Bun.spawn([join(root, "bin", "sdkmanager"), ...args]);')).toBe(true);
    expect(directlyExecutesSdkManager('const binary = "sdkmanager"; spawn(binary, args);')).toBe(true);
    expect(directlyExecutesSdkManager('const binary = `sdkmanager`; Bun.spawn([binary, "--list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('const binary = "sdk" + "manager"; execFile(binary, args);')).toBe(true);
  });

  test("detects aliased launchers and shell wrappers", () => {
    expect(directlyExecutesSdkManager('const { spawn: launch } = childProcess; launch("sdkmanager", ["--list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('const run = childProcess.spawn; run("sdkmanager", ["--list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('import { execFile as run } from "node:child_process"; run("sdkmanager", ["--list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('execFile("/bin/sh", ["-c", "sdkmanager --list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('execSync("sdkmanager --list");')).toBe(true);
  });

  test("allows diagnostic text that does not execute sdkmanager", () => {
    expect(directlyExecutesSdkManager('logger.info("Install with sdkmanager --list");')).toBe(false);
  });

  test("does not allow tool discovery to execute sdkmanager for version probing", () => {
    const detection = readFileSync(join(ROOT, "src/utils/android-cmdline-tools/detection.ts"), "utf8");
    expect(detection).not.toContain("sdkmanagerPath} --version");
    expect(detection).not.toContain("sdkmanagerBatPath} --version");
  });
});
