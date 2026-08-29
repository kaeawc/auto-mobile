import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findViolationsInSource,
  repositoryPath,
} from "../../scripts/check-ios-ctrl-proxy-process-boundary";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = join(ROOT, "src/utils/ios/IOSCtrlProxyProcessClient.ts");
const CHECK = join(ROOT, "scripts/check-ios-ctrl-proxy-process-boundary.ts");

describe("iOS CtrlProxy process execution boundary (issue #4063)", () => {
  test("keeps ps, pgrep, and kill ownership in the lifecycle client", () => {
    const manager = readFileSync(join(ROOT, "src/utils/IOSCtrlProxyManager.ts"), "utf8");
    expect(manager).not.toMatch(/processExecutor\.exec\(\s*["'`](?:ps|pgrep|kill)/);
    expect(readFileSync(OWNER, "utf8")).toMatch(/executeCommand\(\s*"pgrep"/);
  });

  test("rejects direct and wrapped process APIs for lifecycle tools", () => {
    expect(findViolationsInSource("fixture.ts", 'execFile("kill", ["-9", "42"]);')).toHaveLength(1);
    expect(
      findViolationsInSource("fixture.ts", 'host.executeCommand("ps", ["-p", "42"]);'),
    ).toHaveLength(1);
    expect(
      findViolationsInSource("fixture.ts", 'Bun.spawn(["pgrep", "-x", "xcodebuild"]);'),
    ).toHaveLength(1);
    expect(
      findViolationsInSource("fixture.ts", 'host.executeCommand("xcrun", ["simctl", "list"]);'),
    ).toEqual([]);
  });

  test("rejects aliases, spread argv, shell wrappers, and computed seams", () => {
    expect(
      findViolationsInSource(
        "fixture.ts",
        'const tool = "kill"; executor.executeCommand(tool, ["-TERM", "42"]);',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource("fixture.ts", 'spawn("/bin/sh", ["-c", "kill -TERM 42"]);'),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'const command = ["lsof", "-iTCP:8765"]; executor.executeCommand(...command);',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource("fixture.ts", 'executor["executeCommand"]("ps", ["-p", "42"]);'),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'import * as cp from "node:child_process"; cp["spawn"]("kill", ["-TERM", "42"]);',
      ),
    ).toHaveLength(1);
    expect(findViolationsInSource("fixture.ts", 'runner.exec("kill", ["42"]);')).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'function regex(){ const runner = /x/; runner.exec("kill"); } function process(){ runner.exec("kill", ["42"]); }',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'function regex(){ return runner.exec("kill"); } const runner = /x/; regex();',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner: RegExp; { runner = /x/; } runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'function regex(){ { var runner = /x/; } return runner.exec("kill"); }',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner: RegExp; function regex(){ return runner.exec("kill"); } runner = /x/; regex();',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'const runner = executor; for (let runner = /x/; condition;) { runner.exec("kill"); }',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'function regex(runner: unknown) { { runner = /x/; } return (runner as RegExp).exec("kill"); }',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'const runner = executor; namespace N { const runner = /x/; runner.exec("kill"); }',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'function configure(run = exec) {} const run = (label: string) => label; run("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'interface Runner { exec(command: string): unknown } function run(runner: Runner = /x/) { runner.exec("kill"); } run(executor);',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'const regex = (runner = /x/) => runner.exec("kill"); const launch = (runner = executor) => runner.exec("kill");',
      ),
    ).toHaveLength(2);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner = /x/; function regex(){ runner.exec("kill"); } regex(); runner = executor;',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'var runner = executor; var runner = /x/; runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let { runner } = source; { runner = /x/; } runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner = /x/; function configure(){ runner = executor; } runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner: RegExp; (() => { runner = /x/; })(); runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner = /x/; { function configure(){ runner = executor; } } runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner: RegExp; const config = { configure() { runner = /x/; } }; config.configure(); runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner: RegExp; const config = { configure() { runner = /x/; } }; config["configure"](); runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner: RegExp; let configure = () => { runner = /x/; }; configure = () => {}; configure(); runner.exec("kill");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner: RegExp; const configure = function inner(){ runner = /x/; }; configure(); runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner = /x/; try { throw executor; } catch (runner) { runner = executor; } runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner = /x/; function* configure(){ runner = executor; } configure(); runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner = executor; const config = { configure(){ runner = /x/; } }; function invoke(config: unknown){ config.configure(); } invoke(other); runner.exec("kill");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'const base = {}; const config = { ...base }; runner.exec("kill");',
      ),
    ).toHaveLength(1);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner: RegExp; class Config { static configure(){ runner = /x/; } } Config.configure(); runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner = /x/; function configure(){ runner = executor; } unrelated(); runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner = /x/; function regex(){ runner.exec("kill"); } regex(); runner = executor; function unused(){ regex(); }',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner=executor; function configure(){runner=/x/;} const run=configure; run(); runner.exec("kill");',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner=executor; function regex(){runner=/x/; runner.exec("kill");} regex();',
      ),
    ).toHaveLength(0);
    expect(
      findViolationsInSource(
        "fixture.ts",
        'let runner=executor; class Config { constructor(){runner=/x/;} } new Config(); runner.exec("kill");',
      ),
    ).toHaveLength(0);
  });

  test("has a production check with documented exceptions", () => {
    const source = readFileSync(CHECK, "utf8");
    expect(source).toContain("const EXCEPTIONS = new Map<string, string>([");
    expect(source).toContain("IOSCtrlProxyProcessClient.ts");
    expect(readFileSync(join(ROOT, "package.json"), "utf8")).toContain(
      "check:ios-ctrl-proxy-process-boundary",
    );
    expect(readFileSync(join(ROOT, "scripts/all_fast_validate_checks.sh"), "utf8")).toContain(
      "ios-ctrl-proxy-process-boundary",
    );
    expect(readFileSync(join(ROOT, "turbo.json"), "utf8")).toContain(
      '"check:ios-ctrl-proxy-process-boundary"',
    );
    expect(readFileSync(join(ROOT, ".github/workflows/pull_request.yml"), "utf8")).toContain(
      "Check iOS CtrlProxy process execution boundary",
    );
  });

  test("normalizes Windows separators before applying ownership exceptions", () => {
    expect(repositoryPath("src\\utils\\ios\\IOSCtrlProxyProcessClient.ts")).toBe(
      "src/utils/ios/IOSCtrlProxyProcessClient.ts",
    );
  });
});
