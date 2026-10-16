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
    expect(suite.verify).toEqual({ answerIncludes: [], screenIncludes: [] });
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
  });

  test("loadSuite resolves the prompt beside the suite and the APK from the repo root", () => {
    const root = resolve("/repo");
    const suitePath = join(root, "benchmark", "agent", "suites", "demo.yml");
    const promptPath = join(root, "benchmark", "agent", "prompts", "demo.md");
    const files: Record<string, string> = {
      [suitePath]:
        "name: demo\nplatform: android\nprompt: ../prompts/demo.md\napp:\n  packageName: com.example\n  apkPath: build/app.apk\n",
      [promptPath]: "Do the thing.\n",
    };
    const fs = { readFile: (path: string) => files[path] ?? "" };
    const suite = loadSuite(suitePath, root, fs);
    expect(suite.promptPath).toBe(promptPath);
    expect(suite.prompt).toBe("Do the thing.\n");
    expect(suite.apkPath).toBe(join(root, "build", "app.apk"));
  });

  test("an empty prompt is rejected", () => {
    const fs = {
      readFile: (path: string) =>
        path.endsWith(".yml")
          ? "name: demo\nplatform: android\nprompt: p.md\napp:\n  packageName: com.example\n"
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
