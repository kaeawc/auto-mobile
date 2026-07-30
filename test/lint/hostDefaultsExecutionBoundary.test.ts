import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = "src/utils/HostDefaultsClient.ts";

// child_process launch primitives, plus the executor-seam method the repo uses
// (`HostCommandExecutor.executeCommand`). Callers that promisify or otherwise
// alias one of these are recovered separately via `wrapperNames`.
const LAUNCHER_NAMES = "spawn|spawnSync|spawnCommand|exec|execSync|execFile|execFileSync|executeCommand";
// Opening string-literal quote: single, double, or backtick.
const QUOTE = "[\"'`]";

/**
 * Names bound to a promisified/aliased `child_process` launcher, e.g.
 * `const execFileAsync = promisify(execFile);` or `const run = execFile;`. Such
 * a name invoked with a leading `"defaults"` literal is the same violation as a
 * direct launcher call — the guard must recognize the launch semantically, not
 * only the literal `execFile("defaults"` spelling.
 *
 * Bounded by design: this covers the concrete promisify/alias evasions the repo
 * actually uses (see `src/utils/hostAppearance.ts`, `HostCommandExecutor.ts`).
 * A launcher smuggled through a data structure, a computed member, or a
 * cross-module indirection is out of scope for this regex detector; a new
 * production `defaults` path in those exotic forms would need a manual review
 * catch, and this comment marks the deliberate limit.
 */
function wrapperNames(source: string): string[] {
  // const <name> = promisify(execFile) | util.promisify(exec) | execFile;
  const pattern = new RegExp(
    String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*(?:(?:\w+\.)?promisify\s*\(\s*(?:${LAUNCHER_NAMES})\s*\)|(?:${LAUNCHER_NAMES}))\s*;`,
    "g"
  );
  return [...source.matchAll(pattern)].map(match => match[1]);
}

/**
 * Detects direct production execution of the host `defaults` binary (issue
 * #4062). Only the first-argument form is a violation: simulator `defaults`
 * commands pass `"defaults"` as a later element of a `simctl spawn` argv (e.g.
 * `["spawn", udid, "defaults", ...]`), so keying on the launch call's *first*
 * argument leaves those SimCtlClient paths untouched.
 */
export function directlyExecutesHostDefaults(source: string): boolean {
  // execFile("defaults", ...) / spawn("defaults", ...) / executeCommand("defaults", ...)
  const literalFirstArg = new RegExp(String.raw`\b(?:${LAUNCHER_NAMES})\s*\(\s*${QUOTE}defaults${QUOTE}`);
  // exec("defaults read -g ...") — shell string whose command word is `defaults`.
  const shellString = new RegExp(String.raw`\b(?:exec|execSync)\s*\(\s*${QUOTE}defaults\s`);
  // Bun.spawn(["defaults", ...]) — argv array whose first element is the binary.
  const bunSpawn = new RegExp(String.raw`\bBun\.spawn\s*\(\s*\[\s*${QUOTE}defaults${QUOTE}`);
  if (literalFirstArg.test(source) || shellString.test(source) || bunSpawn.test(source)) {
    return true;
  }

  // A promisified/aliased launcher invoked as `<name>("defaults", ...)`, where
  // `<name>` is a launcher captured by `wrapperNames` (e.g. `execFileAsync`).
  return wrapperNames(source).some(name =>
    new RegExp(String.raw`\b${name}\s*\(\s*${QUOTE}defaults[\s${QUOTE.slice(1, -1)}]`).test(source)
  );
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
  });

  test("does not flag simulator defaults routed through a simctl argv", () => {
    expect(directlyExecutesHostDefaults('simctl.executeCommandArgs(["spawn", udid, "defaults", "read", domain, key]);')).toBe(false);
    expect(directlyExecutesHostDefaults('spawn("xcrun", ["simctl", "spawn", udid, "defaults", "read"]);')).toBe(false);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the client.
    ]);
    const files = sourceFiles(join(ROOT, "src"));
    expect([...exceptions.keys()].filter(path => !files.some(file => relative(ROOT, file).split("\\").join("/") === path))).toEqual([]);
  });
});
