import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLIENT = "src/utils/android-cmdline-tools/AvdManagerClient.ts";

function directlyExecutesAvdManager(source: string): boolean {
  const launcher = /\b(?:spawn|spawnSync|spawnCommand|exec|execFile|execFileSync|Bun\.spawn)\s*\(/;
  const directLiteral =
    /\b(?:spawn|spawnSync|spawnCommand|exec|execFile|execFileSync)\s*\(\s*["'`][^"'`]*avdmanager/i;
  const constructedPath = /\b(?:join|resolve)\s*\([^;\n]*["'`]avdmanager(?:\.bat)?["'`]/i;
  const variableNames = [
    ...source.matchAll(
      /\b(?:const|let|var)\s+(\w+)\s*=\s*[^;]*?(?:\b(?:join|resolve)\s*\([^;]*?)?["'`]avdmanager(?:\.bat)?["'`][^;]*;/gi,
    ),
  ].map((match) => match[1]);
  const variableLaunch = variableNames.some((name) =>
    new RegExp(
      `\\b(?:spawn|spawnSync|spawnCommand|exec|execFile|execFileSync)\\s*\\(\\s*${name}\\b|\\bBun\\.spawn\\s*\\(\\s*\\[\\s*${name}\\b`,
    ).test(source),
  );
  const inlineLaunch =
    /\b(?:spawn|spawnSync|spawnCommand|exec|execFile|execFileSync)\s*\(\s*(?:join|resolve)\s*\([^;\n]*["'`]avdmanager|\bBun\.spawn\s*\(\s*\[\s*(?:join|resolve)\s*\([^;\n]*["'`]avdmanager/i;
  return (
    directLiteral.test(source) ||
    inlineLaunch.test(source) ||
    (launcher.test(source) && constructedPath.test(source) && variableLaunch)
  );
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("avdmanager execution boundary (issue #4051)", () => {
  test("only AvdManagerClient directly executes avdmanager", () => {
    const exceptions = new Map<string, string>([
      // Diagnostic-only references are allowed only with a concrete reason here.
    ]);
    const offenders = sourceFiles(join(ROOT, "src")).flatMap((file) => {
      const repoPath = relative(ROOT, file);
      if (repoPath === CLIENT || exceptions.has(repoPath)) {
        return [];
      }
      const source = readFileSync(file, "utf8");
      return directlyExecutesAvdManager(source)
        ? [`${repoPath} directly executes avdmanager; route it through ${CLIENT} instead.`]
        : [];
    });

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("detects a resolved avdmanager path passed to spawn", () => {
    expect(
      directlyExecutesAvdManager(
        'const command = join(sdkRoot, "bin", "avdmanager"); spawn(command, args);',
      ),
    ).toBe(true);
  });

  test("detects arbitrary path variable names and alternate launch APIs", () => {
    expect(
      directlyExecutesAvdManager(
        'const binary = join(sdkRoot, "bin", "avdmanager"); execFile(binary, args);',
      ),
    ).toBe(true);
    expect(
      directlyExecutesAvdManager(
        'const tool = join(sdkRoot, "bin", "avdmanager"); Bun.spawn([tool, ...args]);',
      ),
    ).toBe(true);
  });

  test("detects inline resolved paths passed to launch APIs", () => {
    expect(directlyExecutesAvdManager('spawn(join(sdkRoot, "bin", "avdmanager"), args);')).toBe(
      true,
    );
    expect(
      directlyExecutesAvdManager('Bun.spawn([join(sdkRoot, "bin", "avdmanager"), ...args]);'),
    ).toBe(true);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the client.
    ]);
    expect(
      [...exceptions.keys()].filter(
        (path) => !sourceFiles(join(ROOT, "src")).some((file) => relative(ROOT, file) === path),
      ),
    ).toEqual([]);
  });
});
