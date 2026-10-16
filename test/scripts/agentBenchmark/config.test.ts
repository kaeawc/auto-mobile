import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
  prompt: "../prompts/demo.md",
  app: { packageName: "com.example" },
  verify: { answerIncludes: ["DONE"] },
};

describe("agent benchmark suite config", () => {
  test("a minimal suite gets safe defaults", () => {
    const suite = parseSuiteDefinition(MINIMAL, "demo.yml");
    expect(suite.preflight).toEqual({ clearAppData: true, settleSeconds: 2 });
    expect(suite.claude).toMatchObject({
      allowedTools: ["mcp__auto-mobile"],
      disallowedTools: ["Bash"],
      timeoutSeconds: 900,
      extraArgs: [],
    });
    expect(suite.verify).toEqual({ answerIncludes: ["DONE"], screenIncludes: [] });
    expect(suite.failurePatterns).toEqual([]);
  });

  test("unknown keys, bad names, and --model in extraArgs fail fast with every issue", () => {
    expect(() => parseSuiteDefinition({ ...MINIMAL, baselin: {} }, "x.yml")).toThrow(
      /Unrecognized key\(s\) in object: 'baselin'/,
    );
    expect(() => parseSuiteDefinition({ ...MINIMAL, name: "Bad Name" }, "x.yml")).toThrow(
      /name: use lowercase/,
    );
    expect(() =>
      parseSuiteDefinition({ ...MINIMAL, claude: { extraArgs: ["--model=opus"] } }, "x.yml"),
    ).toThrow(/claude.extraArgs: set claude.model/);
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
    const promptPath = join(root, "benchmark", "agent", "prompts", "demo.md");
    const files: Record<string, string> = {
      [suitePath]:
        "name: demo\nplatform: android\nprompt: ../prompts/demo.md\napp:\n  packageName: com.example\n  apkPath: build/app.apk\nverify:\n  answerIncludes: [DONE]\n",
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

  test("extraArgs cannot resume or continue an earlier conversation", () => {
    for (const extraArgs of [
      ["--resume", "abc"],
      ["--resume=abc"],
      ["-r"],
      ["--continue"],
      ["-c"],
      ["--fork-session"],
    ]) {
      expect(() => parseSuiteDefinition({ ...MINIMAL, claude: { extraArgs } }, "x.yml")).toThrow(
        /must not resume or continue a session/,
      );
    }
    expect(
      parseSuiteDefinition({ ...MINIMAL, claude: { extraArgs: ["--effort", "high"] } }, "x.yml")
        .claude.extraArgs,
    ).toEqual(["--effort", "high"]);
  });

  test("a suite with no verification check is rejected", () => {
    const withoutVerify = { ...MINIMAL, verify: undefined };
    expect(() => parseSuiteDefinition(withoutVerify, "x.yml")).toThrow(
      /verify: verify needs at least one answerIncludes or screenIncludes entry/,
    );
    expect(() =>
      parseSuiteDefinition(
        { ...MINIMAL, verify: { answerIncludes: [], screenIncludes: [] } },
        "x.yml",
      ),
    ).toThrow(/without one a run passes without doing the task/);
    expect(
      parseSuiteDefinition({ ...MINIMAL, verify: { screenIncludes: ["Done"] } }, "x.yml").verify,
    ).toEqual({ answerIncludes: [], screenIncludes: ["Done"] });
  });

  test("an empty prompt is rejected", () => {
    const fs = {
      readFile: (path: string) =>
        path.endsWith(".yml")
          ? "name: demo\nplatform: android\nprompt: p.md\napp:\n  packageName: com.example\nverify:\n  answerIncludes: [DONE]\n"
          : "  \n",
    };
    expect(() => loadSuite(resolve("/s/demo.yml"), resolve("/repo"), fs)).toThrow(
      `prompt ${resolve("/s/p.md")} is empty`,
    );
  });

  test("every committed suite loads and its name matches its file", () => {
    const files = readdirSync(SUITES_DIR).filter((file) => file.endsWith(".yml"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const suite = loadSuite(join(SUITES_DIR, file), REPO_ROOT);
      expect(`${suite.definition.name}.yml`).toBe(file);
    }
  });

  test("shortToolName strips only the auto-mobile MCP prefix", () => {
    expect(shortToolName("mcp__auto-mobile__tapOn")).toBe("tapOn");
    expect(shortToolName("mcp__other__tapOn")).toBe("mcp__other__tapOn");
    expect(shortToolName("ToolSearch")).toBe("ToolSearch");
  });
});
