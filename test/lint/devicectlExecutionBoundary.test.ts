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
  if (!source.includes("devicectl") || !/(?:spawn|exec|execute|Bun)/i.test(source)) {return false;}
  const ast = executionBoundaryAst(source);
  return ast.calls.some(call => {
    if (!ast.isLauncher(call) && !ast.isExecutionSeam(call)) {return false;}
    if (ast.isRunExecSeam(call)) {
      const command = ast.objectPropertyValues(call.arguments[2], "command");
      const args = ast.objectPropertyValues(call.arguments[2], "args");
      return command.some(value => ast.strings(value).some(commandValue => /(?:^|[/\\])xcrun$/.test(commandValue))) &&
        args.some(value => ast.strings(value).includes("devicectl"));
    }
    const alternatives = ast.arrayAlternatives(call.arguments[0]) ?? [[call.arguments[0]]];
    return alternatives.some(([command, ...arrayArgs]) => {
      const args = arrayArgs.length > 0 ? arrayArgs : call.arguments.slice(1);
      const commandValues = ast.strings(command);
      const xcrun = commandValues.some(value => /(?:^|[/\\])xcrun$/.test(value));
      const directDevicectl = commandValues.some(value => /(?:^|[/\\])devicectl$/.test(value));
      const shellDevicectl = commandValues.some(value => /(?:^|[\s;&|])xcrun\s+devicectl(?:\s|$|[;&|])/.test(value));
      const argvAlternatives = arrayArgs.length > 0 ? [arrayArgs] : ast.arrayAlternatives(call.arguments[1]) ?? [];
      const shellWrappedDevicectl = argvAlternatives.some(argv => {
        const shellIndex = argv.findIndex(argument => ast.strings(argument).includes("-c"));
        return shellIndex >= 0 && ast.strings(argv[shellIndex + 1]).some(value => /(?:^|[\s;&|])xcrun\s+devicectl(?:\s|$|[;&|])/.test(value));
      });
      const argvWrappedDevicectl = commandValues.some(value => value === "env" || value === "sudo") &&
        argvAlternatives.some(argv => {
          const values = argv.flatMap(argument => ast.strings(argument));
          const commandIndex = values.findIndex(value => !value.startsWith("-") && !value.includes("="));
          return values[commandIndex] === "xcrun" && values.slice(commandIndex + 1).includes("devicectl");
        });
      return shellDevicectl || shellWrappedDevicectl || argvWrappedDevicectl || directDevicectl ||
        xcrun && args.some(argument => ast.strings(argument).includes("devicectl"));
    });
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
      const repoPath = relative(ROOT, file).replace(/\\/g, "/");
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
    expect(directlyExecutesDevicectl(
      'await this.execFileAsync("xcrun", ["devicectl", "device", "list"]);'
    )).toBe(true);
    expect(directlyExecutesDevicectl('execFile("xcrun" as const, ["devicectl", "device", "list"]);')).toBe(true);
  });

  test("detects Bun.spawn devicectl launches", () => {
    expect(directlyExecutesDevicectl(
      'Bun.spawn(["xcrun", "devicectl", "device", "info", "processes"]);'
    )).toBe(true);
  });

  test("detects shell, direct-binary, and absolute xcrun devicectl forms", () => {
    expect(directlyExecutesDevicectl('exec("xcrun devicectl device list");')).toBe(true);
    expect(directlyExecutesDevicectl('const tool = "xcrun"; exec(`${tool} devicectl device list`);')).toBe(true);
    expect(directlyExecutesDevicectl('exec("echo ok;xcrun devicectl&&echo done");')).toBe(true);
    expect(directlyExecutesDevicectl('execFile("devicectl", ["--version"]);')).toBe(true);
    expect(directlyExecutesDevicectl('spawn("/usr/bin/xcrun", ["devicectl", "device", "list"]);')).toBe(true);
    expect(directlyExecutesDevicectl('spawn("/bin/sh", ["-c", "xcrun devicectl device list"]);')).toBe(true);
    expect(directlyExecutesDevicectl('Bun.spawn(["bash", "-c", "xcrun devicectl device list"]);')).toBe(true);
    expect(directlyExecutesDevicectl('spawn("env", ["xcrun", "devicectl", "device", "list"]);')).toBe(true);
    expect(directlyExecutesDevicectl('execFile("sudo", ["xcrun", "devicectl", "device", "list"]);')).toBe(true);
    expect(directlyExecutesDevicectl(
      'spawn("bash", enabled ? ["-c", "xcrun devicectl device list"] : ["-c", "echo ok"]);'
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
    expect(directlyExecutesDevicectl(
      'const command = "xcrun"; const args = ["devicectl", "--version"]; runExecSeam(cb, opts, { command, args });'
    )).toBe(true);
    expect(directlyExecutesDevicectl(
      'const run = runExecSeam; run(cb, opts, { command: "xcrun", args: ["devicectl", "--version"] });'
    )).toBe(true);
    expect(directlyExecutesDevicectl(
      'let run; run = executeCommand; run("xcrun", ["devicectl", "--version"]);'
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

  test("does not treat unrelated execute methods as a process seam", () => {
    expect(directlyExecutesDevicectl('db.execute("xcrun", ["devicectl"]);')).toBe(false);
    expect(directlyExecutesDevicectl('this.processExecutor.execute("xcrun", ["devicectl"]);')).toBe(true);
  });

  test("detects a static shell prefix without joining across dynamic values", () => {
    expect(directlyExecutesDevicectl('exec("xcrun devicectl device list " + udid);')).toBe(true);
    expect(directlyExecutesDevicectl('exec("xcrun devi" + suffix + "cectl");')).toBe(false);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the owner.
    ]);
    expect([...exceptions.keys()].filter(path => !sourceFiles(join(ROOT, "src")).some(file => relative(ROOT, file) === path))).toEqual([]);
  });
});
