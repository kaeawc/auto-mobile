import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  directlyExecutesSdkManager,
  findOffenders,
  OWNER as CLIENT,
  sourceFiles,
} from "../../scripts/check-sdkmanager-execution-boundary";

const ROOT = join(import.meta.dir, "..", "..");

describe("sdkmanager execution boundary (issue #4052)", () => {
  test("only SdkManagerClient directly executes sdkmanager", () => {
    const files = sourceFiles(join(ROOT, "src"));
    // A silently-empty scan yields zero offenders and passes green while checking nothing.
    expect(files.length).toBeGreaterThan(100);
    const offenders = findOffenders(ROOT);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("detects resolved paths passed to supported launch APIs", () => {
    expect(directlyExecutesSdkManager('const binary = join(root, "bin", "sdkmanager"); execFile(binary, args);')).toBe(true);
    expect(directlyExecutesSdkManager('Bun.spawn([join(root, "bin", "sdkmanager"), ...args]);')).toBe(true);
    expect(directlyExecutesSdkManager('const binary = "sdkmanager"; spawn(binary, args);')).toBe(true);
    expect(directlyExecutesSdkManager('const binary = `sdkmanager`; Bun.spawn([binary, "--list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('const binary = "sdk" + "manager"; execFile(binary, args);')).toBe(true);
  });

  test("detects template-literal paths", () => {
    expect(directlyExecutesSdkManager("spawn(`${dir}/bin/sdkmanager`, [\"--list\"]);")).toBe(true);
    expect(directlyExecutesSdkManager("exec(`${command} sdkmanager --list`);")).toBe(true);
    expect(directlyExecutesSdkManager("const binary = `${root}/bin/sdkmanager`; execFile(binary, args);")).toBe(true);
    expect(directlyExecutesSdkManager("spawn(`${dir}/bin/avdmanager`, [\"list\"]);")).toBe(false);
    // Known blind spot, and the price of not matching across chunk boundaries: a tool name
    // split by an interpolation reads as two unrelated chunks.
    expect(directlyExecutesSdkManager("spawn(`${dir}/bin/sdk${x}manager`, []);")).toBe(false);
  });

  test("detects sdkmanager reached through deferred assignment", () => {
    expect(directlyExecutesSdkManager(
      "let command: string;\ncommand = `${sdkmanagerPath} --version`;\nsystemDetection.exec(command);",
    )).toBe(true);
    expect(directlyExecutesSdkManager(
      'let binary;\nbinary = "sdkmanager";\nexecFile(binary, ["--list"]);',
    )).toBe(true);
    expect(directlyExecutesSdkManager(
      'let binary;\nbinary = "avdmanager";\nexecFile(binary, ["list"]);',
    )).toBe(false);
  });

  test("detects aliased launchers and shell wrappers", () => {
    expect(directlyExecutesSdkManager('const { spawn: launch } = childProcess; launch("sdkmanager", ["--list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('const run = childProcess.spawn; run("sdkmanager", ["--list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('import { execFile as run } from "node:child_process"; run("sdkmanager", ["--list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('execFile("/bin/sh", ["-c", "sdkmanager --list"]);')).toBe(true);
    expect(directlyExecutesSdkManager('execSync("sdkmanager --list");')).toBe(true);
  });

  test("detects promisified launchers, the dominant idiom in src/", () => {
    expect(directlyExecutesSdkManager(
      'const execFileAsync = promisify(execFile); await execFileAsync(sdkmanagerPath, ["--list"]);',
    )).toBe(true);
    expect(directlyExecutesSdkManager(
      "const execAsync = promisify(exec); await execAsync(`${sdkmanagerPath} --list`);",
    )).toBe(true);
    expect(directlyExecutesSdkManager('await promisify(execFile)(sdkmanagerPath, ["--list"]);')).toBe(true);
    expect(directlyExecutesSdkManager(
      'const execAsync = util.promisify(exec); await execAsync("sdkmanager --list");',
    )).toBe(true);
    expect(directlyExecutesSdkManager(
      "const readFileAsync = promisify(readFile); await readFileAsync(sdkmanagerPath);",
    )).toBe(false);
  });

  test("detects sdkmanager reached across functions via a parameter (issue #4341)", () => {
    // The launcher call site names only the parameter `bin`; the tool name lives at the
    // caller. A purely call-site-local reading (the pre-#4341 behaviour) misses this.
    expect(directlyExecutesSdkManager(
      'function run(bin) { execFile(bin, args); }\nrun("sdkmanager");',
    )).toBe(true);
    // A different tool passed the same way must not trip the guard.
    expect(directlyExecutesSdkManager(
      'function run(bin) { execFile(bin, args); }\nrun("avdmanager");',
    )).toBe(false);
    // Two hops: caller -> intermediate -> launcher.
    expect(directlyExecutesSdkManager(
      "function launch(cmd) { execFile(cmd, args); }\nfunction run(bin) { launch(bin); }\nrun(\"sdkmanager\");",
    )).toBe(true);
  });

  test("detects production-shaped resolve-in-one-method / spawn-in-another (issue #4341)", () => {
    // Mirrors SdkManagerClient's structure: one method resolves the binary path to a
    // static "sdkmanager", another method spawns the resolved path. No sdkmanager text
    // sits at the launcher call site, so only interprocedural reasoning catches it.
    const prodShaped = [
      "class Tool {",
      "  private resolveExecutable(location) { return join(location.path, \"bin\", \"sdkmanager\"); }",
      "  private execute(path, args) { return this.deps.spawn(path, args, {}); }",
      "  async run(args) { const path = this.resolveExecutable(loc); return this.execute(path, args); }",
      "}",
    ].join("\n");
    expect(directlyExecutesSdkManager(prodShaped)).toBe(true);
    // Same structure resolving a different tool must stay clean.
    const prodShapedOther = prodShaped.replace("sdkmanager", "avdmanager");
    expect(directlyExecutesSdkManager(prodShapedOther)).toBe(false);
  });

  test("fires on the real SdkManagerClient, a true positive on production code (issue #4341)", () => {
    const client = readFileSync(join(ROOT, CLIENT), "utf8");
    expect(directlyExecutesSdkManager(client)).toBe(true);
  });

  test("detects Bun.$ tagged-template execution (issue #4341)", () => {
    expect(directlyExecutesSdkManager("await Bun.$`sdkmanager --list`;")).toBe(true);
    expect(directlyExecutesSdkManager("await $`sdkmanager --list`;")).toBe(true);
    expect(directlyExecutesSdkManager("await Bun.$`${dir}/bin/sdkmanager --list`;")).toBe(true);
    expect(directlyExecutesSdkManager("await Bun.$`avdmanager list`;")).toBe(false);
  });

  test("allows diagnostic text that does not execute sdkmanager", () => {
    expect(directlyExecutesSdkManager('logger.info("Install with sdkmanager --list");')).toBe(false);
  });

  test("does not allow tool discovery to execute sdkmanager for version probing", () => {
    const detection = readFileSync(join(ROOT, "src/utils/android-cmdline-tools/detection.ts"), "utf8");
    expect(directlyExecutesSdkManager(detection)).toBe(false);
    // The predicate above duplicates the src-wide scan, so keep one pin the detector cannot
    // give: a version probe routed through a launcher this file does not recognize.
    expect(detection).not.toMatch(/sdkmanager[A-Za-z]*(Path|BatPath)\}\s*--version/i);
  });
});
