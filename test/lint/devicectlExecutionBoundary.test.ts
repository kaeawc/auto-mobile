import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { executionBoundaryAst } from "../../scripts/lib/executionBoundaryAst";

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
 * DeviceAppManager itself is excluded as the owner. Elsewhere, an injected
 * `execute(file, args)` seam is treated as a launch boundary too, so a refactor
 * cannot hide a literal xcrun/devicectl call behind that indirection.
 */
function directlyExecutesDevicectl(source: string): boolean {
  const ast = executionBoundaryAst(source);
  return ast.calls.some(call => {
    if (!ast.isLauncher(call) && !ast.isExecutionSeam(call)) {return false;}
    if (ast.calleeName(call) === "runExecSeam") {
      const values = call.arguments.flatMap(argument => ast.strings(argument));
      return values.includes("xcrun") && values.includes("devicectl");
    }
    const array = ast.arrayElements(call.arguments[0]);
    const command = array?.[0] ?? call.arguments[0];
    const args = array ? array.slice(1) : call.arguments.slice(1);
    return ast.strings(command).includes("xcrun") && args.some(argument => ast.strings(argument).includes("devicectl"));
  });
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

  test("detects injected execute seams while ignoring sibling tools and comments", () => {
    // An injected execute(file, args) seam outside the owner can bypass the boundary.
    expect(directlyExecutesDevicectl(
      'await this.execute("xcrun", ["devicectl", "device", "uninstall", "app"]);'
    )).toBe(true);
    expect(directlyExecutesDevicectl(
      'const file = "xcrun"; const args = ["devicectl", "device", "uninstall", "app"]; await execute(file, args);'
    )).toBe(true);
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
