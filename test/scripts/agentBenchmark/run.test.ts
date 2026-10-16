import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { parseCliArgs, resolveSuitePath } from "../../../scripts/agent-benchmark/run";

describe("agent benchmark CLI arguments", () => {
  test("runs suites by name with overrides", () => {
    expect(
      parseCliArgs([
        "--suite",
        "bug-repro",
        "--suite",
        "ux-flow",
        "--device",
        "emulator-5554",
        "--model",
        "m",
        "--json",
      ]),
    ).toMatchObject({
      suites: ["bug-repro", "ux-flow"],
      device: "emulator-5554",
      model: "m",
      json: true,
      dryRun: false,
      claude: "claude",
    });
    expect(parseCliArgs(["--all", "--dry-run"])).toMatchObject({ all: true, dryRun: true });
    expect(parseCliArgs(["--from-result", "/out/run"]).fromResults).toEqual(["/out/run"]);
    expect(parseCliArgs(["--all", "--output", "rel/dir"]).output).toBe(resolve("rel/dir"));
  });

  test("a relative --claude path is resolved now; a bare name is left for PATH", () => {
    // Claude runs from a temp cwd, where a relative path would no longer resolve.
    expect(parseCliArgs(["--all", "--claude", "./node_modules/.bin/claude"]).claude).toBe(
      resolve("./node_modules/.bin/claude"),
    );
    expect(parseCliArgs(["--all", "--claude", "claude-beta"]).claude).toBe("claude-beta");
  });

  test("exactly one mode is required, and flags need values", () => {
    expect(() => parseCliArgs([])).toThrow(/Pass --suite\/--all to run/);
    expect(() => parseCliArgs(["--all", "--from-result", "x"])).toThrow(/not both/);
    expect(() => parseCliArgs(["--suite"])).toThrow(/--suite needs a value/);
    expect(() => parseCliArgs(["--suite", "--json"])).toThrow(/--suite needs a value/);
    expect(() => parseCliArgs(["--all", "--bogus"])).toThrow(/Unknown argument: --bogus/);
    expect(parseCliArgs(["--help"]).help).toBe(true);
  });

  test("suite names map into the suites directory; YAML paths are used as given", () => {
    expect(resolveSuitePath("bug-repro", "/suites")).toBe(join("/suites", "bug-repro.yml"));
    expect(resolveSuitePath("local/custom.yaml", "/suites")).toBe(resolve("local/custom.yaml"));
  });
});
