import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { executionBoundaryAst } from "../../scripts/lib/executionBoundaryAst";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = "src/utils/HostDefaultsClient.ts";

/**
 * Detects direct production execution of the host `defaults` binary (issue
 * #4062). Only the first-argument form is a violation: simulator `defaults`
 * commands pass `"defaults"` as a later element of a `simctl spawn` argv (e.g.
 * `["spawn", udid, "defaults", ...]`), so keying on the launch call's *first*
 * argument leaves those SimCtlClient paths untouched.
 */
export function directlyExecutesHostDefaults(source: string): boolean {
  if (!source.includes("defaults") || !/(?:spawn|exec|execute|Bun)/i.test(source)) {return false;}
  const ast = executionBoundaryAst(source);
  return ast.calls.some(call => {
    if (!ast.isLauncher(call) && !ast.isExecutionSeam(call)) {return false;}
    const first = call.arguments[0];
    const array = ast.arrayElements(first);
    const command = array?.[0] ?? first;
    return ast.strings(command).some(value => value === "defaults" || value.startsWith("defaults "));
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("host defaults execution boundary (issue #4062)", () => {
  test("only HostDefaultsClient directly executes the host defaults binary", () => {
    const exceptions = new Map<string, string>([
      // Diagnostic-only references are allowed only with a concrete reason here.
    ]);
    const files = sourceFiles(join(ROOT, "src"));
    // A silently-empty scan yields zero offenders and passes green while checking nothing.
    expect(files.length).toBeGreaterThan(100);

    const offenders = files.flatMap(file => {
      const repoPath = relative(ROOT, file).split("\\").join("/");
      if (repoPath === OWNER || exceptions.has(repoPath)) {return [];}
      const source = readFileSync(file, "utf8");
      return directlyExecutesHostDefaults(source)
        ? [`${repoPath} directly executes host defaults; route it through ${OWNER} instead.`]
        : [];
    });

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("flags direct launcher invocations of defaults", () => {
    expect(directlyExecutesHostDefaults('execFile("defaults", ["read", "-g", key]);')).toBe(true);
    expect(directlyExecutesHostDefaults('spawn("defaults", ["read", "-g", "AppleInterfaceStyle"]);')).toBe(true);
    expect(directlyExecutesHostDefaults('await executor.executeCommand("defaults", ["read", "-g", key]);')).toBe(true);
    expect(directlyExecutesHostDefaults('exec("defaults read -g AppleInterfaceStyle");')).toBe(true);
    expect(directlyExecutesHostDefaults('Bun.spawn(["defaults", "read", "-g", key]);')).toBe(true);
  });

  test("flags a promisified or aliased launcher invoked with defaults", () => {
    // The original hostAppearance.ts evasion: promisify(execFile) then call the wrapper.
    expect(directlyExecutesHostDefaults(
      'const execFileAsync = promisify(execFile); await execFileAsync("defaults", ["read", "-g", key]);'
    )).toBe(true);
    expect(directlyExecutesHostDefaults(
      'const run = util.promisify(exec); await run("defaults read -g AppleInterfaceStyle");'
    )).toBe(true);
    expect(directlyExecutesHostDefaults(
      'const launch = execFile; launch("defaults", ["read", "-g", key]);'
    )).toBe(true);
    // The command may be assembled through ordinary constants before the alias call.
    expect(directlyExecutesHostDefaults(
      'const command = "defaults"; const run = promisify(execFile); run(command, ["read", "-g", key]);'
    )).toBe(true);
    expect(directlyExecutesHostDefaults(
      'import { execFile as run } from "node:child_process"; run("defaults", ["read"]);'
    )).toBe(true);
    expect(directlyExecutesHostDefaults(
      'const { execFile: run } = childProcess; run("defaults", ["read"]);'
    )).toBe(true);
    expect(directlyExecutesHostDefaults(
      'let run; run = execFile; run("defaults", ["read"]);'
    )).toBe(true);
    expect(directlyExecutesHostDefaults(
      'const cp = require("node:child_process"); cp.execFile("defaults", ["read"]);'
    )).toBe(true);
  });

  test("does not flag simulator defaults routed through a simctl argv", () => {
    expect(directlyExecutesHostDefaults('simctl.executeCommandArgs(["spawn", udid, "defaults", "read", domain, key]);')).toBe(false);
    expect(directlyExecutesHostDefaults('spawn("xcrun", ["simctl", "spawn", udid, "defaults", "read"]);')).toBe(false);
  });

  test("does not mistake unrelated methods named exec for process launchers", () => {
    expect(directlyExecutesHostDefaults('const matcher = /defaults/; matcher.exec("defaults");')).toBe(false);
  });

  test("detects a static shell prefix without joining across dynamic values", () => {
    expect(directlyExecutesHostDefaults('exec("defaults read -g " + key);')).toBe(true);
    expect(directlyExecutesHostDefaults('exec("defau" + key + "lts read");')).toBe(false);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the client.
    ]);
    const files = sourceFiles(join(ROOT, "src"));
    expect([...exceptions.keys()].filter(path => !files.some(file => relative(ROOT, file).split("\\").join("/") === path))).toEqual([]);
  });
});
