import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = "src/utils/ios-cmdline-tools/DeviceAppManager.ts";

/**
 * True when `source` hands `devicectl` to a process launcher directly — i.e. a
 * production call that bypasses the single {@link OWNER} boundary. We look for a
 * launcher primitive (exec/execFile/spawn family, promisified or not, plus
 * `Bun.spawn`) whose argument list contains a `devicectl` string literal.
 * DeviceAppManager itself never trips this: it routes every invocation through
 * its injected `execute` seam, not a launcher primitive.
 */
function directlyExecutesDevicectl(source: string): boolean {
  const launcherWithDevicectl =
    /\b(?:exec|execSync|execFile|execFileSync|execFileAsync|spawn|spawnSync|spawnCommand)\s*\([^;]*?["'`][^"'`]*\bdevicectl\b/;
  const bunSpawnWithDevicectl =
    /Bun\.spawn\s*\(\s*\[[^\]]*?["'`][^"'`]*\bdevicectl\b/;
  return launcherWithDevicectl.test(source) || bunSpawnWithDevicectl.test(source);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("devicectl execution boundary (issue #4053)", () => {
  test("only DeviceAppManager directly executes xcrun devicectl", () => {
    const exceptions = new Map<string, string>([
      // Diagnostic-only references are allowed only with a concrete reason here.
    ]);
    const offenders = sourceFiles(join(ROOT, "src")).flatMap(file => {
      const repoPath = relative(ROOT, file);
      if (repoPath === OWNER || exceptions.has(repoPath)) {return [];}
      const source = readFileSync(file, "utf8");
      return directlyExecutesDevicectl(source)
        ? [`${repoPath} directly executes devicectl; route it through ${OWNER} instead.`]
        : [];
    });

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("detects execFile-style devicectl launches", () => {
    expect(directlyExecutesDevicectl(
      'execFileAsync("xcrun", ["devicectl", "device", "info", "apps"]);'
    )).toBe(true);
    expect(directlyExecutesDevicectl(
      'execFile("xcrun", [\n  "devicectl", "device", "install", "app"\n]);'
    )).toBe(true);
    expect(directlyExecutesDevicectl(
      'spawnSync("xcrun", ["devicectl", "--version"]);'
    )).toBe(true);
  });

  test("detects Bun.spawn devicectl launches", () => {
    expect(directlyExecutesDevicectl(
      'Bun.spawn(["xcrun", "devicectl", "device", "info", "processes"]);'
    )).toBe(true);
  });

  test("does not flag the injected execute seam or comments", () => {
    // DeviceAppManager routes through this.execute(...), not a launcher primitive.
    expect(directlyExecutesDevicectl(
      'await this.execute("xcrun", ["devicectl", "device", "uninstall", "app"]);'
    )).toBe(false);
    // Prose mentioning devicectl must not be a violation.
    expect(directlyExecutesDevicectl(
      "// route physical-device app queries through devicectl behind DeviceAppManager"
    )).toBe(false);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the owner.
    ]);
    expect([...exceptions.keys()].filter(path => !sourceFiles(join(ROOT, "src")).some(file => relative(ROOT, file) === path))).toEqual([]);
  });
});
