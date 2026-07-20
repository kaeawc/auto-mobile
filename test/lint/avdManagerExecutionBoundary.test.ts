import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLIENT = "src/utils/android-cmdline-tools/AvdManagerClient.ts";

function directlyExecutesAvdManager(source: string): boolean {
  const executesProcess = /\b(?:spawn|spawnCommand)\s*\(/.test(source);
  const avdmanagerPath = /(?:\b(?:const|let|var)\s+(?:\w*(?:path|command|executable)\w*)\s*=\s*[^;\n]*["'`]avdmanager(?:\.bat)?["'`]|\b(?:join|resolve)\s*\([^\n]*["'`]avdmanager(?:\.bat)?["'`]|\b(?:spawn|spawnCommand)\s*\(\s*["'`][^"'`]*avdmanager)/i.test(source);
  return executesProcess && avdmanagerPath;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("avdmanager execution boundary (issue #4051)", () => {
  test("only AvdManagerClient directly executes avdmanager", () => {
    const exceptions = new Map<string, string>([
      // Diagnostic-only references are allowed only with a concrete reason here.
    ]);
    const offenders = sourceFiles(join(ROOT, "src")).flatMap(file => {
      const repoPath = relative(ROOT, file);
      if (repoPath === CLIENT || exceptions.has(repoPath)) {return [];}
      const source = readFileSync(file, "utf8");
      return directlyExecutesAvdManager(source)
        ? [`${repoPath} directly executes avdmanager; route it through ${CLIENT} instead.`]
        : [];
    });

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("detects a resolved avdmanager path passed to spawn", () => {
    expect(directlyExecutesAvdManager(
      'const command = join(sdkRoot, "bin", "avdmanager"); spawn(command, args);'
    )).toBe(true);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the client.
    ]);
    expect([...exceptions.keys()].filter(path => !sourceFiles(join(ROOT, "src")).some(file => relative(ROOT, file) === path))).toEqual([]);
  });
});
