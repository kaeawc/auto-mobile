import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSuite } from "../../../scripts/agent-benchmark/config";
import {
  adbClientIdentity,
  adbRoutedRunner,
  assertDirectlyLaunchable,
  bundleDigest,
  dryRunReport,
  fileSha256,
  harnessAdbIdentity,
  importClosure,
  killProcessGroupRemnants,
  killProcessTree,
  parseCliArgs,
  suiteRunOptions,
  resolveCommand,
  resolveSuitePath,
  staleBuildSource,
} from "../../../scripts/agent-benchmark/run";

describe("agent benchmark process tree kill", () => {
  test("signals the whole POSIX process group, falling back to the process", () => {
    const signals: Array<[number, string]> = [];
    const taskkill: number[] = [];
    killProcessTree(42, "SIGTERM", "linux", {
      kill: (pid, signal) => signals.push([pid, signal]),
      taskkill: (pid) => taskkill.push(pid),
    });
    expect(signals).toEqual([[-42, "SIGTERM"]]);
    const fallback: Array<[number, string]> = [];
    killProcessTree(42, "SIGKILL", "darwin", {
      kill: (pid, signal) => {
        fallback.push([pid, signal]);
        if (pid < 0) {
          throw new Error("ESRCH");
        }
      },
      taskkill: (pid) => taskkill.push(pid),
    });
    expect(fallback).toEqual([
      [-42, "SIGKILL"],
      [42, "SIGKILL"],
    ]);
    expect(taskkill).toEqual([]);
  });

  test("walks the tree with taskkill on Windows", () => {
    const taskkill: number[] = [];
    killProcessTree(7, "SIGTERM", "win32", {
      kill: () => undefined,
      taskkill: (pid) => taskkill.push(pid),
    });
    expect(taskkill).toEqual([7]);
  });

  test("kills only an exited leader's group remnants, never the reusable PID", () => {
    const signals: Array<[number, string]> = [];
    killProcessGroupRemnants(42, "linux", (pid, signal) => {
      signals.push([pid, signal]);
      throw new Error("ESRCH");
    });
    // An empty group is the normal case; the PID itself is never signalled.
    expect(signals).toEqual([[-42, "SIGKILL"]]);
    const windows: number[] = [];
    killProcessGroupRemnants(42, "win32", (pid) => windows.push(pid));
    expect(windows).toEqual([]);
  });
});

describe("agent benchmark build freshness and command resolution", () => {
  test("a build older than any source is stale", () => {
    const sources = [
      { path: "src/a.ts", mtimeMs: 100 },
      { path: "schemas/tool-definitions.json", mtimeMs: 300 },
    ];
    expect(staleBuildSource(200, sources)).toBe("schemas/tool-definitions.json");
    expect(staleBuildSource(300, sources)).toBeUndefined();
  });

  test("a relative command resolves against the invocation directory", () => {
    const cwd = resolve("/work");
    expect(resolveCommand("./bin/claude", () => null, cwd)).toBe(resolve(cwd, "bin/claude"));
    expect(resolveCommand("claude", () => "/usr/local/bin/claude", cwd)).toBe(
      "/usr/local/bin/claude",
    );
    expect(resolveCommand("claude", () => null, cwd)).toBe("claude");
  });
});

describe("agent benchmark --claude launchability", () => {
  test("refuses a Windows command script up front, and nothing elsewhere", () => {
    expect(() => assertDirectlyLaunchable("claude", "win32", () => "C:\\npm\\claude.CMD")).toThrow(
      /Windows command script/,
    );
    expect(() =>
      assertDirectlyLaunchable("claude", "win32", () => "C:\\bin\\claude.exe"),
    ).not.toThrow();
    expect(() => assertDirectlyLaunchable("claude.cmd", "linux", () => null)).not.toThrow();
  });
});

describe("agent benchmark --claude identity", () => {
  test("hashes a wrapper larger than one read chunk by its whole content", () => {
    const dir = mkdtempSync(join(tmpdir(), "amb-sha-"));
    try {
      // Past 1 MiB, so the hash spans more than one chunk, as a bundled wrapper would.
      const content = Buffer.alloc(1024 * 1024 + 7, 1);
      const path = join(dir, "claude");
      writeFileSync(path, content);
      expect(fileSha256(path)).toBe(createHash("sha256").update(content).digest("hex"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent benchmark harness adb identity", () => {
  test("fingerprints the adb the harness runs, separately from the server's", () => {
    expect(
      harnessAdbIdentity("/sdk/platform-tools/adb", (adb) =>
        adb === "/sdk/platform-tools/adb" ? "Version 36.0.0\n" : undefined,
      ),
    ).toBe("Version 36.0.0");
    expect(harnessAdbIdentity("adb", () => undefined)).toBe("unavailable:adb");
  });

  test("routes only bare adb commands to the resolved client", async () => {
    const calls: string[] = [];
    const runner = adbRoutedRunner(
      {
        async run(command) {
          calls.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      "/sdk/platform-tools/adb",
    );
    await runner.run("adb", ["devices"], 1_000);
    await runner.run("xcrun", ["simctl"], 1_000);
    expect(calls).toEqual(["/sdk/platform-tools/adb", "xcrun"]);
  });
});

describe("agent benchmark adb client identity", () => {
  test("records every client the server might pick, so a change to any one counts", async () => {
    const versions: Record<string, string> = {
      "/sdk/platform-tools/adb": "Version 35.0.2\n",
      "/usr/bin/adb": "Version 36.0.0\n",
      "/home/u/Android/Sdk/platform-tools/adb": "Version 34.0.5\n",
    };
    const identity = await adbClientIdentity(
      { ANDROID_HOME: "/sdk" },
      (adb) => versions[adb.replaceAll("\\", "/")],
      () => "/usr/bin/adb",
      async () => "/home/u/Android/Sdk/platform-tools/adb",
    );
    expect(identity).toBe(
      ["sdk=Version 35.0.2", "path=Version 36.0.0", "detected=Version 34.0.5"].join("\n"),
    );
    // Missing or silent candidates are named, so appearing later still changes the identity.
    expect(
      await adbClientIdentity(
        { ANDROID_HOME: "/stale" },
        () => undefined,
        () => null,
        async () => null,
      ),
    ).toMatch(
      /^sdk=unavailable:.*platform-tools\/adb\npath=unavailable:none\ndetected=unavailable:none$/,
    );
  });
});

describe("agent benchmark dry run", () => {
  test("the MCP config carries the inherited adb routing the real run will use", () => {
    const root = resolve(import.meta.dir, "../../..");
    const suite = loadSuite(join(root, "benchmark/agent/suites/bug-repro.yml"), root);
    const report = dryRunReport(suite, parseCliArgs(["--suite", "bug-repro", "--dry-run"]), {
      ADB_SERVER_SOCKET: "tcp:10.0.0.5:5037",
    });
    expect(report).toContain('"ADB_SERVER_SOCKET":"tcp:10.0.0.5:5037"');
    expect(report).not.toContain("AUTOMOBILE_SERVER_INSTRUCTIONS");
  });

  test("--server-instructions shows the instructions arm in the MCP config", () => {
    const root = resolve(import.meta.dir, "../../..");
    const suite = loadSuite(join(root, "benchmark/agent/suites/bug-repro.yml"), root);
    const report = dryRunReport(
      suite,
      parseCliArgs(["--suite", "bug-repro", "--dry-run", "--server-instructions"]),
      {},
    );
    expect(report).toContain('"AUTOMOBILE_SERVER_INSTRUCTIONS":"1"');
  });
});

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
    expect(parseCliArgs(["--all", "--dry-run"])).toMatchObject({
      all: true,
      dryRun: true,
      serverInstructions: false,
    });
    expect(parseCliArgs(["--all", "--server-instructions"]).serverInstructions).toBe(true);
    expect(parseCliArgs(["--from-result", "/out/run"]).fromResults).toEqual(["/out/run"]);
    expect(parseCliArgs(["--all", "--output", "rel/dir"]).output).toBe(resolve("rel/dir"));
  });

  test("every suite run carries the CLI overrides and the instructions arm", () => {
    const resolved = {
      serverEntry: "/repo/dist/src/index.js",
      serverBuild: "b",
      claudeCommand: "c",
    };
    expect(
      suiteRunOptions(
        parseCliArgs(["--suite", "bug-repro", "--model", "m", "--server-instructions"]),
        resolved,
        "/usr/bin/bun",
      ),
    ).toMatchObject({
      ...resolved,
      runtime: "/usr/bin/bun",
      modelOverride: "m",
      serverInstructions: true,
    });
    expect(
      suiteRunOptions(parseCliArgs(["--suite", "bug-repro"]), resolved).serverInstructions,
    ).toBe(false);
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

describe("agent benchmark harness import closure", () => {
  const graph: Record<string, string[]> = {
    "/repo/scripts/agent-benchmark/run.ts": ["./device", "../../src/utils/lock", "node:fs"],
    "/repo/scripts/agent-benchmark/device.ts": ["../../src/utils/lock", "zod"],
    "/repo/src/utils/lock.ts": ["./timer"],
    "/repo/src/utils/timer.ts": ["./lock"],
  };
  const resolveIn = (specifier: string, fromDir: string) => {
    if (specifier === "zod") {
      return "/repo/node_modules/zod/index.js";
    }
    if (!specifier.startsWith(".")) {
      return undefined;
    }
    const parts = `${fromDir}/${specifier}`.split("/");
    const stack = parts.reduce<string[]>(
      (path, part) => (part === ".." ? path.slice(0, -1) : part === "." ? path : [...path, part]),
      [],
    );
    return `${stack.join("/")}.ts`;
  };

  test("follows repository imports transitively, once each, and stops at packages", () => {
    expect(
      importClosure(
        ["/repo/scripts/agent-benchmark/run.ts"],
        (path) => graph[path] ?? [],
        resolveIn,
        (path) => !path.includes("/node_modules/"),
      ),
    ).toEqual([
      "/repo/scripts/agent-benchmark/device.ts",
      "/repo/scripts/agent-benchmark/run.ts",
      "/repo/src/utils/lock.ts",
      "/repo/src/utils/timer.ts",
    ]);
  });
});
