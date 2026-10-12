import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import plugin from "../../oxlint-plugins/auto-mobile.mjs";
import { runRule } from "./oxlintRuleHarness";

const count = (code: string): number => runRule(plugin.rules["no-direct-bun-spawn"], code).length;

describe("auto-mobile/no-direct-bun-spawn", () => {
  test("flags each of Bun's process launchers, however the Bun object is reached", () => {
    for (const code of [
      'Bun.spawn(["adb", "devices"]);',
      'Bun.spawnSync({ cmd: ["adb"] });',
      "await Bun.$`adb devices`;",
      'const launch = Bun.spawn; launch(["adb"]);',
      'Bun["spawn"](["adb"]);',
      'globalThis.Bun.spawnSync(["adb"]);',
      "const quiet = Bun.$.nothrow();",
    ]) {
      expect(count(code), code).toBe(1);
    }
  });

  test("flags launchers taken off Bun by destructuring or imported from the bun module", () => {
    expect(count("const { spawn, $: shell, version } = Bun;")).toBe(2);
    expect(count("const { ...everything } = Bun;")).toBe(1);
    expect(count('import { $, spawn as launch, spawnSync, file } from "bun";')).toBe(3);
  });

  test("flags every way of taking the whole bun module under another name", () => {
    for (const code of [
      'import * as bun from "bun"; bun.spawn(["adb"]);',
      'import B from "bun"; B.spawn(["adb"]);',
      'const bun = require("bun");',
      'const bun = await import("bun");',
      'export { spawn } from "bun";',
      'export * from "bun";',
    ]) {
      expect(count(code), code).toBe(1);
    }
  });

  test("leaves the rest of Bun, type-only imports and other objects' spawn alone", () => {
    for (const code of [
      'Bun.file("a.txt"); Bun.write("a.txt", "x"); Bun.main; Bun.version;',
      "const { file, version } = Bun;",
      'import { file, serve } from "bun";',
      'import type { spawn, Subprocess } from "bun";',
      'import { type spawn, file } from "bun";',
      'this.processExecutor.spawn("adb", ["devices"]); executor.spawnSync("git");',
      'import { spawn } from "./HostCommandExecutor";',
      "const { spawn } = executor;",
    ]) {
      expect(count(code), code).toBe(0);
    }
  });

  test("the message names the seam, and the rule is an error for src/", () => {
    const [message] = runRule(plugin.rules["no-direct-bun-spawn"], "Bun.spawn([]);");
    expect(message).toContain("HostCommandExecutor");
    const config = readFileSync(new URL("../../.oxlintrc.json", import.meta.url), "utf8");
    expect(config).toContain('"auto-mobile/no-direct-bun-spawn": "error"');
  });
});
