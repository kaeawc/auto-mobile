import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import {
  loadSuite,
  parseSuiteDefinition,
  shortToolName,
} from "../../../scripts/agent-benchmark/config";
import { SUITES_DIR } from "../../../scripts/agent-benchmark/run";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

const MINIMAL = {
  name: "demo",
  platform: "android",
  prompt: "../prompts/demo.txt",
  app: { packageName: "com.example" },
  verify: { answerIncludes: ["DONE"], screenIncludes: ["Done"] },
};

describe("agent benchmark suite config", () => {
  test("a minimal suite gets safe defaults", () => {
    const suite = parseSuiteDefinition(MINIMAL, "demo.yml");
    expect(suite.preflight).toEqual({
      clearAppData: true,
      settleSeconds: 2,
      startScreenIncludes: [],
    });
    expect(suite.claude.disallowedTools).toEqual(["Bash", "PowerShell"]);
    // A suite's own denials add to the Bash ban instead of replacing it.
    expect(
      parseSuiteDefinition({ ...MINIMAL, claude: { disallowedTools: ["mcp__x__y"] } }, "x.yml")
        .claude.disallowedTools,
    ).toEqual(["Bash", "PowerShell", "mcp__x__y"]);
    expect(suite.claude).toMatchObject({
      allowedTools: ["mcp__auto-mobile"],
      disallowedTools: ["Bash", "PowerShell"],
      timeoutSeconds: 900,
    });
    expect(suite.verify).toEqual({ answerIncludes: ["DONE"], screenIncludes: ["Done"] });
    expect(suite.failurePatterns).toEqual([]);
  });

  test("unknown keys and bad names fail fast with every issue", () => {
    expect(() => parseSuiteDefinition({ ...MINIMAL, baselin: {} }, "x.yml")).toThrow(
      /Unrecognized key\(s\) in object: 'baselin'/,
    );
    expect(() => parseSuiteDefinition({ ...MINIMAL, name: "Bad Name" }, "x.yml")).toThrow(
      /name: use lowercase/,
    );
    // No free-form Claude flags: --settings, --resume, --plugin-dir and the like would undo
    // run isolation, so extraArgs is not a suite key at all.
    expect(() =>
      parseSuiteDefinition(
        { ...MINIMAL, claude: { extraArgs: ["--settings", "x.json"] } },
        "x.yml",
      ),
    ).toThrow(/Unrecognized key\(s\) in object: 'extraArgs'/);
    // The tool lists follow a variadic flag, so an option-shaped entry would become a flag.
    for (const claude of [
      { allowedTools: ["mcp__auto-mobile", "--settings", "/tmp/s.json"] },
      { disallowedTools: ["-p"] },
    ]) {
      expect(() => parseSuiteDefinition({ ...MINIMAL, claude }, "x.yml")).toThrow(
        /a tool rule cannot start with '-'/,
      );
    }
    expect(() =>
      parseSuiteDefinition(
        { ...MINIMAL, preflight: { sharedPreferences: { "../escape": { a: true } } } },
        "x.yml",
      ),
    ).toThrow(/preference file names are plain identifiers/);
    expect(() => parseSuiteDefinition({ ...MINIMAL, platform: "ios", app: {} }, "x.yml")).toThrow(
      /platform: .*; app.packageName: Required/,
    );
    for (const packageName of ["com.example; reboot", "example", "com.example app"]) {
      expect(() => parseSuiteDefinition({ ...MINIMAL, app: { packageName } }, "x.yml")).toThrow(
        /app.packageName: use an Android package name/,
      );
    }
  });

  test("loadSuite resolves the prompt beside the suite and the APK from the repo root", () => {
    const root = resolve("/repo");
    const suitePath = join(root, "benchmark", "agent", "suites", "demo.yml");
    const promptPath = join(root, "benchmark", "agent", "prompts", "demo.txt");
    const files: Record<string, string> = {
      [suitePath]:
        "name: demo\nplatform: android\nprompt: ../prompts/demo.txt\napp:\n  packageName: com.example\n  apkPath: build/app.apk\nverify:\n  answerIncludes: [DONE]\n  screenIncludes: [Done]\n",
      [promptPath]: "Do the thing.\n",
    };
    const fs = { readFile: (path: string) => files[path] ?? "" };
    const suite = loadSuite(suitePath, root, fs);
    expect(suite.promptPath).toBe(promptPath);
    expect(suite.prompt).toBe("Do the thing.\n");
    expect(suite.apkPath).toBe(join(root, "build", "app.apk"));
  });

  test("preference integers must be safe so Android can parse them", () => {
    const prefs = (value: number) => ({
      ...MINIMAL,
      preflight: { sharedPreferences: { p: { value } } },
    });
    expect(() => parseSuiteDefinition(prefs(1e21), "x.yml")).toThrow(/must be safe integers/);
    expect(() => parseSuiteDefinition(prefs(2 ** 53), "x.yml")).toThrow(/must be safe integers/);
    expect(parseSuiteDefinition(prefs(2 ** 40), "x.yml").preflight.sharedPreferences).toEqual({
      p: { value: 2 ** 40 },
    });
    expect(parseSuiteDefinition(prefs(0.5), "x.yml").preflight.sharedPreferences).toEqual({
      p: { value: 0.5 },
    });
  });

  test("non-integer preferences must survive Android's 32-bit float", () => {
    const prefs = (value: number) => ({
      ...MINIMAL,
      preflight: { sharedPreferences: { p: { value } } },
    });
    // Every double past 2^53 is an integer, so overflow is already the safe-integer rule's job.
    expect(() => parseSuiteDefinition(prefs(1e100), "x.yml")).toThrow(/must be safe integers/);
    for (const value of [1e-100, -1e-50, 1e-46]) {
      expect(() => parseSuiteDefinition(prefs(value), "x.yml")).toThrow(/32-bit float/);
    }
    // Float32's smallest subnormal and ordinary fractions survive.
    for (const value of [1.401298464324817e-45, 1.5e-40, 0.1, 123456.75]) {
      expect(parseSuiteDefinition(prefs(value), "x.yml").preflight.sharedPreferences).toEqual({
        p: { value },
      });
    }
  });

  test("preference keys and strings must be valid XML text", () => {
    const prefs = (entries: Record<string, unknown>) => ({
      ...MINIMAL,
      preflight: { sharedPreferences: { p: entries } },
    });
    for (const entries of [
      { name: "a\u0000b" },
      { name: "\u001F" },
      { ["bad\u0007key"]: true },
      { name: "\uD800" },
    ]) {
      expect(() => parseSuiteDefinition(prefs(entries), "x.yml")).toThrow(/valid XML text/);
    }
    expect(
      parseSuiteDefinition(prefs({ name: "tab\tnew\nline 😀 & <ok>" }), "x.yml").preflight
        .sharedPreferences,
    ).toEqual({ p: { name: "tab\tnew\nline 😀 & <ok>" } });
  });

  test("a suite without a device screen check is rejected", () => {
    // The screen is the oracle: an answer alone can be echoed without touching the app.
    for (const verify of [
      undefined,
      { answerIncludes: [], screenIncludes: [] },
      { answerIncludes: ["DONE"] },
    ]) {
      expect(() => parseSuiteDefinition({ ...MINIMAL, verify }, "x.yml")).toThrow(
        /verify.screenIncludes: verify.screenIncludes needs at least one entry/,
      );
    }
    expect(
      parseSuiteDefinition({ ...MINIMAL, verify: { screenIncludes: ["Done"] } }, "x.yml").verify,
    ).toEqual({ answerIncludes: [], screenIncludes: ["Done"] });
  });

  test("an empty prompt is rejected", () => {
    const fs = {
      readFile: (path: string) =>
        path.endsWith(".yml")
          ? "name: demo\nplatform: android\nprompt: p.txt\napp:\n  packageName: com.example\nverify:\n  answerIncludes: [DONE]\n  screenIncludes: [Done]\n"
          : "  \n",
    };
    expect(() => loadSuite(resolve("/s/demo.yml"), resolve("/repo"), fs)).toThrow(
      `prompt ${resolve("/s/p.txt")} is empty`,
    );
  });

  test("baseline counts must be safe integers", () => {
    // 2^53 + 1 parses as 2^53, so a larger count would already be wrong.
    for (const baseline of [{ numTurns: 2 ** 53 }, { tools: { tapOn: 2 ** 53 } }]) {
      expect(() => parseSuiteDefinition({ ...MINIMAL, baseline }, "demo.yml")).toThrow(
        /must be a safe integer/,
      );
    }
    expect(
      parseSuiteDefinition({ ...MINIMAL, baseline: { totalToolCalls: 12 } }, "demo.yml").baseline,
    ).toMatchObject({ totalToolCalls: 12 });
  });

  test("baseline cost and wall-clock must be finite", () => {
    for (const baseline of [{ costUsd: Infinity }, { wallClockSeconds: Infinity }]) {
      expect(() => parseSuiteDefinition({ ...MINIMAL, baseline }, "demo.yml")).toThrow();
    }
  });

  test("settle and timeout delays must be finite and timer-safe", () => {
    for (const preflight of [{ settleSeconds: Infinity }, { settleSeconds: 3_000_000 }]) {
      expect(() =>
        parseSuiteDefinition({ ...MINIMAL, preflight: preflight }, "demo.yml"),
      ).toThrow();
    }
    expect(() =>
      parseSuiteDefinition({ ...MINIMAL, claude: { timeoutSeconds: 3_000_000 } }, "demo.yml"),
    ).toThrow();
  });

  test("blank match strings are rejected", () => {
    expect(() =>
      parseSuiteDefinition(
        { ...MINIMAL, verify: { ...MINIMAL.verify, screenIncludes: [" "] } },
        "demo.yml",
      ),
    ).toThrow(/must not be blank/);
    expect(() => parseSuiteDefinition({ ...MINIMAL, failurePatterns: ["\t"] }, "demo.yml")).toThrow(
      /must not be blank/,
    );
  });

  test("a Markdown prompt is rejected, since CI skips tests on docs-only changes", () => {
    expect(() => parseSuiteDefinition({ ...MINIMAL, prompt: "p.md" }, "demo.yml")).toThrow(
      /use a \.txt prompt/,
    );
  });

  test("every committed suite loads and its name matches its file", () => {
    // The same predicate --all discovery uses, so a .yaml suite cannot skip this guard.
    const files = readdirSync(SUITES_DIR).filter((file) => /\.ya?ml$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const suite = loadSuite(join(SUITES_DIR, file), REPO_ROOT);
      expect(`${suite.definition.name}${extname(file)}`).toBe(file);
      // Every shipped suite checks its start screen, so a broken preflight never reaches Claude.
      expect(suite.definition.preflight.startScreenIncludes.length).toBeGreaterThan(0);
    }
  });

  test("shortToolName strips only the auto-mobile MCP prefix", () => {
    expect(shortToolName("mcp__auto-mobile__tapOn")).toBe("tapOn");
    expect(shortToolName("mcp__other__tapOn")).toBe("mcp__other__tapOn");
    expect(shortToolName("ToolSearch")).toBe("ToolSearch");
  });
});
