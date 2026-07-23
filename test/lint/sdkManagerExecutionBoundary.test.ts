import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLIENT = "src/utils/android-cmdline-tools/SdkManagerClient.ts";

function directlyExecutesSdkManager(source: string): boolean {
  const launcher = /\b(?:spawn|spawnSync|spawnCommand|exec|execFile|execFileSync|Bun\.spawn)\s*\(/;
  const directLiteral = /\b(?:spawn|spawnSync|spawnCommand|exec|execFile|execFileSync)\s*\(\s*["'`][^"'`]*sdkmanager|\bBun\.spawn\s*\(\s*\[\s*["'`][^"'`]*sdkmanager/i;
  const constructedPath = /\b(?:join|resolve)\s*\([^;\n]*["'`]sdkmanager(?:\.bat)?["'`]/i;
  const variableNames = new Set([
    ...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*[^;]*?(?:\b(?:join|resolve)\s*\([^;]*?)?["'`]sdkmanager(?:\.bat)?["'`][^;]*;/gi),
    ...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*["'`]sdkmanager(?:\.bat)?["'`]/gi),
    ...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*["'`]sdk["'`]\s*\+\s*["'`]manager(?:\.bat)?["'`]/gi),
  ].map(match => match[1]));
  const variableLaunch = [...variableNames].some(name => new RegExp(`\\b(?:spawn|spawnSync|spawnCommand|exec|execFile|execFileSync)\\s*\\(\\s*${name}\\b|\\bBun\\.spawn\\s*\\(\\s*\\[\\s*${name}\\b`).test(source));
  const inlineLaunch = /\b(?:spawn|spawnSync|spawnCommand|exec|execFile|execFileSync)\s*\(\s*(?:join|resolve)\s*\([^;\n]*["'`]sdkmanager|\bBun\.spawn\s*\(\s*\[\s*(?:join|resolve)\s*\([^;\n]*["'`]sdkmanager/i;
  return directLiteral.test(source) || inlineLaunch.test(source) || (launcher.test(source) && variableLaunch);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("sdkmanager execution boundary (issue #4052)", () => {
  test("only SdkManagerClient directly executes sdkmanager", () => {
    const exceptions = new Map<string, string>([
      // Keep production diagnostics out of this list unless they cannot use the client.
    ]);
    const offenders = sourceFiles(join(ROOT, "src")).flatMap(file => {
      const repoPath = relative(ROOT, file);
      if (repoPath === CLIENT || exceptions.has(repoPath)) {return [];}
      return directlyExecutesSdkManager(readFileSync(file, "utf8"))
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

  test("does not allow tool discovery to execute sdkmanager for version probing", () => {
    const detection = readFileSync(join(ROOT, "src/utils/android-cmdline-tools/detection.ts"), "utf8");
    expect(detection).not.toContain("sdkmanagerPath} --version");
    expect(detection).not.toContain("sdkmanagerBatPath} --version");
  });
});
