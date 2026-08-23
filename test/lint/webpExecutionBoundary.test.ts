import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { executionBoundaryAst } from "../../scripts/lib/executionBoundaryAst";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = "src/utils/image/webp/WebpBinaryResolver.ts";
const BINARY = "(?:cwebp|dwebp|webpmux)";
const BINARY_COMMAND = new RegExp(`(?:^|[/\\\\\\s;&|])${BINARY}(?:\\.exe)?(?:\\s|$|[;&|])`, "i");

/**
 * A production file "directly executes" a libwebp tool when it launches the
 * binary itself — a literal cwebp/dwebp/webpmux name handed to a process API
 * (including the *Sync spellings and a shell `-c` command string), or a path
 * resolved from the owner's resolveCwebp/resolveDwebp then spawned. The blessed
 * path is `WebpBinaryProvider.runCwebp` / `runDwebp` on the owner, which this
 * heuristic deliberately does not flag.
 *
 * The shared AST analyzer follows ordinary aliases, static variables, and the
 * resolver return path rather than matching raw source text.
 */
function directlyExecutesWebp(source: string): boolean {
  if (!/(?:cwebp|dwebp|webpmux)/i.test(source) || !/(?:spawn|exec|execute|Bun)/i.test(source)) {
    return false;
  }
  const ast = executionBoundaryAst(source);
  return ast.calls.some((call) => {
    if (!ast.isLauncher(call) && !ast.isExecutionSeam(call)) {
      return false;
    }
    const alternatives = ast.arrayAlternatives(call.arguments[0]) ?? [[call.arguments[0]]];
    return alternatives.some(([command, ...arrayArgs]) => {
      const commandValues = ast.strings(command);
      const argvAlternatives =
        arrayArgs.length > 0 ? [arrayArgs] : (ast.arrayAlternatives(call.arguments[1]) ?? []);
      const shellCommand = argvAlternatives.flatMap((argv) => {
        const shellIndex = argv.findIndex((argument) => ast.strings(argument).includes("-c"));
        return shellIndex >= 0 ? ast.strings(argv[shellIndex + 1]) : [];
      });
      return (
        commandValues.some((value) => BINARY_COMMAND.test(value)) ||
        shellCommand.some((value) => BINARY_COMMAND.test(value)) ||
        ast.containsCallNamed(command, new Set(["resolveCwebp", "resolveDwebp"]))
      );
    });
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("webp codec execution boundary (issue #4064)", () => {
  test("only WebpBinaryResolver directly executes cwebp/dwebp/webpmux", () => {
    const exceptions = new Map<string, string>([
      // Diagnostic-only references are allowed only with a concrete reason here.
    ]);
    const offenders = sourceFiles(join(ROOT, "src")).flatMap((file) => {
      const repoPath = relative(ROOT, file).split("\\").join("/");
      if (repoPath === OWNER || exceptions.has(repoPath)) {
        return [];
      }
      const source = readFileSync(file, "utf8");
      return directlyExecutesWebp(source)
        ? [
            `${repoPath} directly executes a libwebp tool; route it through ${OWNER} (WebpBinaryProvider.runCwebp/runDwebp) instead.`,
          ]
        : [];
    });

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("the owner is the single production boundary that resolves and executes the tools", () => {
    const owner = readFileSync(join(ROOT, OWNER), "utf8");
    expect(owner).toContain("async runCwebp(");
    expect(owner).toContain("async runDwebp(");
    expect(owner).toContain("this.processExecutor.spawn(");

    const codec = readFileSync(join(ROOT, "src/utils/image/webp/CliWebpCodec.ts"), "utf8");
    expect(codec).not.toContain(".spawn(");
    expect(codec).toContain("this.binaryResolver.runCwebp(");
    expect(codec).toContain("this.binaryResolver.runDwebp(");
  });

  test("flags literal binary names and resolved paths passed to launch APIs", () => {
    expect(directlyExecutesWebp('spawn("cwebp", ["-o", "-"]);')).toBe(true);
    expect(directlyExecutesWebp('execFile("dwebp", args);')).toBe(true);
    expect(directlyExecutesWebp('Bun.spawn(["webpmux", "-info", file]);')).toBe(true);
    expect(
      directlyExecutesWebp(
        "const command = await this.binaryResolver.resolveCwebp(); this.executor.spawn(command, args);",
      ),
    ).toBe(true);
    expect(
      directlyExecutesWebp("const bin = await resolver.resolveDwebp(); execFile(bin, args);"),
    ).toBe(true);
    expect(
      directlyExecutesWebp(
        'const binary = "cwebp"; const launch = spawn; launch(binary, ["-o", "-"]);',
      ),
    ).toBe(true);
    expect(directlyExecutesWebp('spawn("C:\\\\tools\\\\cwebp.exe", args);')).toBe(true);
    expect(directlyExecutesWebp('const binary = "cwebp" as const; spawn(binary, args);')).toBe(
      true,
    );
  });

  test("flags shell-string and *Sync launcher evasions", () => {
    expect(directlyExecutesWebp('execSync("cwebp -o - -");')).toBe(true);
    expect(directlyExecutesWebp('const tool = "cwebp"; exec(`${tool} -o - -`);')).toBe(true);
    expect(directlyExecutesWebp('spawn("/bin/sh", ["-c", "cwebp -o -"]);')).toBe(true);
    expect(directlyExecutesWebp('Bun.spawn(["bash", "-c", "dwebp -o - --"]);')).toBe(true);
    expect(directlyExecutesWebp('exec("cwebp&&echo done");')).toBe(true);
    expect(directlyExecutesWebp('exec("dwebp; echo done");')).toBe(true);
    expect(directlyExecutesWebp('exec("echo ok;cwebp -o - -");')).toBe(true);
    expect(directlyExecutesWebp('spawnSync("webpmux", ["-info", file]);')).toBe(true);
  });

  test("does not flag the blessed runCwebp/runDwebp delegation", () => {
    expect(
      directlyExecutesWebp("const output = await this.binaryResolver.runCwebp(args, pngBuffer);"),
    ).toBe(false);
    expect(
      directlyExecutesWebp(
        'return this.binaryResolver.runDwebp(["-o", "-", "--", "-"], webpBuffer);',
      ),
    ).toBe(false);
    expect(directlyExecutesWebp("const binaries = await new WebpBinaryResolver().resolve();")).toBe(
      false,
    );
  });

  test("does not mistake codec words in data arguments for execution", () => {
    expect(directlyExecutesWebp('spawn("echo", ["cwebp"]);')).toBe(false);
    expect(directlyExecutesWebp('spawn("echo", ["/tmp/cwebp-result.txt"]);')).toBe(false);
    expect(directlyExecutesWebp('spawn("bash", ["-c", script], { env: { TOOL: "cwebp" } });')).toBe(
      false,
    );
  });

  test("detects a static shell prefix without joining across dynamic values", () => {
    expect(directlyExecutesWebp('exec("cwebp -o - " + input);')).toBe(true);
    expect(directlyExecutesWebp('exec("cwe" + suffix + "bp -o -");')).toBe(false);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the owner.
    ]);
    expect(
      [...exceptions.keys()].filter(
        (path) =>
          !sourceFiles(join(ROOT, "src")).some(
            (file) => relative(ROOT, file).split("\\").join("/") === path,
          ),
      ),
    ).toEqual([]);
  });
});
