import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optimizeSourceMap, selectSourceMaps } from "../../scripts/build/optimize-sourcemap";

/**
 * Bun 1.3.14 rejects maps whose sourcesContent is absent or not as long as sources
 * (InvalidSourceMap, #10849). Parsing JSON cannot catch that, so build two tiny
 * bundles (CLI and worker shapes), run them through the production optimizer, hide
 * the original sources like an installed package, and execute them under Bun.
 */
describe("optimized sourcemaps under the Bun runtime", () => {
  let root = "";
  const outputs: Record<string, { stderr: string; exitCode: number | null }> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "smap-runtime-"));
    const src = join(root, "src");
    mkdirSync(src);
    writeFileSync(
      join(src, "thrower.ts"),
      'export function boom(): never {\n  throw new Error("probe");\n}\n',
    );
    const entry = (name: string) =>
      writeFileSync(
        join(src, `${name}.ts`),
        `import { boom } from "./thrower";\ntry {\n  boom();\n} catch (error) {\n  console.error((error as Error).stack);\n}\n`,
      );
    entry("cli");
    entry("worker");
    const built = await Bun.build({
      entrypoints: [join(src, "cli.ts"), join(src, "worker.ts")],
      outdir: join(root, "dist"),
      target: "bun",
      minify: true,
      sourcemap: "external",
    });
    expect(built.success).toBe(true);
    const emitted = built.outputs.map((output) => output.path);
    for (const { path, options } of selectSourceMaps(emitted, "", { stripSources: true })) {
      const { map } = optimizeSourceMap(JSON.parse(readFileSync(path, "utf8")), options);
      writeFileSync(path, JSON.stringify(map));
    }
    renameSync(src, join(root, "src-removed"));
    for (const name of ["cli", "worker"]) {
      const proc = Bun.spawnSync([process.execPath, join(root, "dist", `${name}.js`)], {
        stderr: "pipe",
        stdout: "pipe",
      });
      outputs[name] = { stderr: proc.stderr.toString(), exitCode: proc.exitCode };
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const name of ["cli", "worker"]) {
    test(`${name} map is accepted and maps frames to original file, line and column`, () => {
      const { stderr, exitCode } = outputs[name];
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("InvalidSourceMap");
      expect(stderr).toMatch(/src\/thrower\.ts:2:13/);
      expect(stderr).toMatch(new RegExp(`src/${name}\\.ts:3:`));
    });
  }
});
