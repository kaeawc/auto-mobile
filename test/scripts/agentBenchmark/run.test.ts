import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { bundleDigest, parseCliArgs, resolveSuitePath } from "../../../scripts/agent-benchmark/run";

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
    expect(() => parseCliArgs([])).toThrow(/Pass one of --suite, --all, or --from-result/);
    expect(() => parseCliArgs(["--all", "--from-result", "x"])).toThrow(/Pass one of/);
    // --all would silently drop an explicit suite, so the two are not combinable.
    expect(() => parseCliArgs(["--all", "--suite", "custom.yml"])).toThrow(/Pass one of/);
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

describe("agent benchmark server build digest", () => {
  const file = (path: string, text: string) => ({
    path,
    read: () => new TextEncoder().encode(text),
  });
  const build = [
    file("src/index.js", "bundle"),
    file("schemas/test-plan.schema.json", "{}"),
    file("src/index.js.map", "map"),
  ];

  test("a sidecar change alters the digest; source maps and listing order do not", () => {
    const base = bundleDigest(build);
    expect(base).toMatch(/^sha256=[0-9a-f]{16}$/);
    expect(bundleDigest([...build].reverse())).toBe(base);
    expect(bundleDigest([build[0], build[1], file("src/index.js.map", "other")])).toBe(base);
    expect(bundleDigest([build[0], file("schemas/test-plan.schema.json", '{"x":1}')])).not.toBe(
      base,
    );
  });

  test("Windows path separators hash the same as POSIX ones", () => {
    const windows = build.map((entry) => ({ ...entry, path: entry.path.replaceAll("/", "\\") }));
    expect(bundleDigest(windows)).toBe(bundleDigest(build));
  });
});
