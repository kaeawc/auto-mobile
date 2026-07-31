import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = "src/utils/ios-cmdline-tools/DeviceAppManager.ts";

/**
 * True when `source` hands `devicectl` to a subprocess directly — i.e. a
 * production call that bypasses the single {@link OWNER} boundary. Two shapes
 * are caught:
 *
 * 1. A launcher primitive (exec/execFile/spawn family, promisified or not, plus
 *    `Bun.spawn`) whose argument list contains a `devicectl` string literal.
 * 2. An INDIRECT launch through the repo's own exec seam —
 *    `HostCommandExecutor.executeCommand("xcrun", ["devicectl", ...])` or a
 *    direct `runExecSeam(...)` — i.e. an `executeCommand`/`runExecSeam` call
 *    whose argv carries both the `xcrun` file and a `devicectl` verb literal.
 *    Requiring the `xcrun` literal keeps benign `executeCommand("adb", ...)` /
 *    `executeCommand("xcrun", ["simctl", ...])` calls off the offender list.
 *
 * DeviceAppManager itself never trips this: it routes every invocation through
 * its injected `execute` seam with the `file`/`args` VARIABLES (no `xcrun` /
 * `devicectl` literal at the call site), and it is the exempt {@link OWNER}.
 *
 * Residual limit: the seam regex scans across a single statement (no `;`), so it
 * would miss a `devicectl` literal hidden behind a block-bodied
 * `runExecSeam(() => { ...; })` callback. That indirection does not exist in the
 * repo (the only seam is `executeCommand`, whose argv is a flat literal array),
 * and any such rewrite would still surface through the launcher-primitive branch.
 */
function directlyExecutesDevicectl(source: string): boolean {
  const launcherWithDevicectl =
    /\b(?:exec|execSync|execFile|execFileSync|execFileAsync|spawn|spawnSync|spawnCommand)\s*\([^;]*?["'`][^"'`]*\bdevicectl\b/;
  const bunSpawnWithDevicectl =
    /Bun\.spawn\s*\(\s*\[[^\]]*?["'`][^"'`]*\bdevicectl\b/;
  const seamXcrunDevicectl =
    /\b(?:executeCommand|runExecSeam)\s*\([^;]*?["'`]xcrun["'`][^;]*?\bdevicectl\b/;
  return launcherWithDevicectl.test(source)
    || bunSpawnWithDevicectl.test(source)
    || seamXcrunDevicectl.test(source);
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

  test("detects INDIRECT devicectl launches through the repo exec seam", () => {
    // HostCommandExecutor.executeCommand("xcrun", ["devicectl", ...]) bypasses
    // the owner just as surely as a raw execFile would.
    expect(directlyExecutesDevicectl(
      'await this.processExecutor.executeCommand("xcrun", ["devicectl", "device", "info", "apps"]);'
    )).toBe(true);
    expect(directlyExecutesDevicectl(
      'await executeCommand("xcrun", [\n  "devicectl", "device", "install", "app"\n]);'
    )).toBe(true);
    expect(directlyExecutesDevicectl(
      'runExecSeam(cb, opts, { command: "xcrun", args: ["devicectl", "--version"] });'
    )).toBe(true);
  });

  test("does not flag the injected execute seam, sibling tools, or comments", () => {
    // DeviceAppManager's injected `execute(file, args)` dep is not a launcher.
    expect(directlyExecutesDevicectl(
      'await this.execute("xcrun", ["devicectl", "device", "uninstall", "app"]);'
    )).toBe(false);
    // The owner's default dep routes VARIABLES through the seam — no literals.
    expect(directlyExecutesDevicectl(
      "return new DefaultHostCommandExecutor().executeCommand(file, args);"
    )).toBe(false);
    // A sibling xcrun tool (simctl) through the same seam is not a devicectl call.
    expect(directlyExecutesDevicectl(
      'await this.processExecutor.executeCommand("xcrun", ["simctl", "list", "devices"]);'
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
