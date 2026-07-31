import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const OWNER = "src/utils/image/webp/WebpBinaryResolver.ts";
const BINARY = "(?:cwebp|dwebp|webpmux)";

/**
 * A production file "directly executes" a libwebp tool when it launches the
 * binary itself — a literal cwebp/dwebp/webpmux name handed to a process API
 * (including the *Sync spellings and a shell `-c` command string), or a path
 * resolved from the owner's resolveCwebp/resolveDwebp then spawned. The blessed
 * path is `WebpBinaryProvider.runCwebp` / `runDwebp` on the owner, which this
 * heuristic deliberately does not flag.
 *
 * Residual limit (bounded to concrete evasions): the binary name must appear as
 * a literal inside a single string token. A name assembled from a variable or
 * string concatenation, or one hidden past same-quote nesting inside a shell
 * string, is not detected — those are out of scope for this guard.
 */
function directlyExecutesWebp(source: string): boolean {
  const launchApis = "(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)";
  // A launcher whose first string argument itself contains the binary, e.g.
  // spawn("cwebp", ...) or execSync("cwebp -o - -").
  const directLiteral = new RegExp(`\\b${launchApis}\\s*\\(\\s*["'\`][^"'\`]*${BINARY}`, "i");
  const bunSpawnLiteral = new RegExp(`Bun\\.spawn(?:Sync)?\\s*\\(\\s*\\[\\s*["'\`][^"'\`]*${BINARY}`, "i");
  // A shell launcher that smuggles the binary through a `-c` command string,
  // e.g. spawn("/bin/sh", ["-c", "cwebp -o -"]) or Bun.spawn(["bash", "-c", "dwebp ..."]).
  const shellCommandString = new RegExp(`["'\`]-c["'\`]\\s*,\\s*["'\`][^"'\`]*${BINARY}`, "i");

  const resolverVarNames = [
    ...source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?[^;]*\.(?:resolveCwebp|resolveDwebp)\s*\([^;]*;/g)
  ].map(match => match[1]);
  const resolverVarLaunch = resolverVarNames.some(name =>
    new RegExp(`\\b${launchApis}\\s*\\(\\s*${name}\\b|Bun\\.spawn(?:Sync)?\\s*\\(\\s*\\[\\s*${name}\\b|\\.spawn\\s*\\(\\s*${name}\\b`).test(source)
  );

  return directLiteral.test(source) || bunSpawnLiteral.test(source) || shellCommandString.test(source) || resolverVarLaunch;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {return sourceFiles(path);}
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("webp codec execution boundary (issue #4064)", () => {
  test("only WebpBinaryResolver directly executes cwebp/dwebp/webpmux", () => {
    const exceptions = new Map<string, string>([
      // Diagnostic-only references are allowed only with a concrete reason here.
    ]);
    const offenders = sourceFiles(join(ROOT, "src")).flatMap(file => {
      const repoPath = relative(ROOT, file).split("\\").join("/");
      if (repoPath === OWNER || exceptions.has(repoPath)) {return [];}
      const source = readFileSync(file, "utf8");
      return directlyExecutesWebp(source)
        ? [`${repoPath} directly executes a libwebp tool; route it through ${OWNER} (WebpBinaryProvider.runCwebp/runDwebp) instead.`]
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
    expect(directlyExecutesWebp(
      "const command = await this.binaryResolver.resolveCwebp(); this.executor.spawn(command, args);"
    )).toBe(true);
    expect(directlyExecutesWebp(
      "const bin = await resolver.resolveDwebp(); execFile(bin, args);"
    )).toBe(true);
  });

  test("flags shell-string and *Sync launcher evasions", () => {
    expect(directlyExecutesWebp('execSync("cwebp -o - -");')).toBe(true);
    expect(directlyExecutesWebp('spawn("/bin/sh", ["-c", "cwebp -o -"]);')).toBe(true);
    expect(directlyExecutesWebp('Bun.spawn(["bash", "-c", "dwebp -o - --"]);')).toBe(true);
    expect(directlyExecutesWebp('spawnSync("webpmux", ["-info", file]);')).toBe(true);
  });

  test("does not flag the blessed runCwebp/runDwebp delegation", () => {
    expect(directlyExecutesWebp("const output = await this.binaryResolver.runCwebp(args, pngBuffer);")).toBe(false);
    expect(directlyExecutesWebp('return this.binaryResolver.runDwebp(["-o", "-", "--", "-"], webpBuffer);')).toBe(false);
    expect(directlyExecutesWebp("const binaries = await new WebpBinaryResolver().resolve();")).toBe(false);
  });

  test("every documented exception still exists", () => {
    const exceptions = new Map<string, string>([
      // Keep this list empty unless a production diagnostic cannot use the owner.
    ]);
    expect(
      [...exceptions.keys()].filter(path => !sourceFiles(join(ROOT, "src")).some(file => relative(ROOT, file).split("\\").join("/") === path))
    ).toEqual([]);
  });
});
