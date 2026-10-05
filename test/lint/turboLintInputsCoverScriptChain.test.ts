import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("turbo lint inputs cover the shell script chain", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  interface TurboConfig {
    readonly tasks: Record<
      string,
      { readonly inputs?: readonly string[]; readonly env?: readonly string[] }
    >;
  }

  interface OxlintConfig {
    readonly jsPlugins?: readonly string[];
  }

  function loadTurbo(): TurboConfig {
    return JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")) as TurboConfig;
  }

  test("PR target is forwarded and hashed for the lint ratchet", () => {
    expect(loadTurbo().tasks.lint?.env).toContain("GITHUB_BASE_REF");
  });

  function lintInputs(): readonly string[] {
    return loadTurbo().tasks.lint?.inputs ?? [];
  }

  function referencedShellScripts(source: string): string[] {
    return [...source.matchAll(/\bbash\s+["']?(scripts\/[^\s"']+\.sh)/g)].map((match) => match[1]);
  }

  function coveredBy(inputs: readonly string[], path: string): boolean {
    return (
      inputs.some((input) => !input.startsWith("!") && new Bun.Glob(input).match(path)) &&
      !inputs.some((input) => input.startsWith("!") && new Bun.Glob(input.slice(1)).match(path))
    );
  }

  test("every shell script in the lint chain exists and invalidates lint", () => {
    const lintScript = "scripts/lint.sh";
    const boundaryScript = "scripts/check-boundaries.sh";
    const referenced = [
      ...referencedShellScripts(readFileSync(join(ROOT, lintScript), "utf8")),
      ...referencedShellScripts(readFileSync(join(ROOT, boundaryScript), "utf8")),
    ];
    const scripts = [...new Set([lintScript, boundaryScript, ...referenced])];
    const inputs = lintInputs();

    expect(scripts.filter((script) => !existsSync(join(ROOT, script)))).toEqual([]);
    expect(scripts.filter((script) => !coveredBy(inputs, script))).toEqual([]);
  });

  test("every config file the lint chain reads exists and invalidates lint", () => {
    // scripts/lint.sh runs `oxlint --fix` (reads .oxlintrc.json, its jsPlugins, and
    // tsconfig.json for the type-aware ratchet), then `oxfmt --write` (reads
    // .oxfmtrc.json and falls back to .editorconfig for unset options), then the
    // ratchet gate against scripts/oxlint-baseline.txt. Editing any of these must
    // bust the turbo cache or a config-only commit replays a stale green lint.
    const oxlintConfig = ".oxlintrc.json";
    // .oxlintrc.json is JSONC (comments), so a naive JSON.parse throws; Bun's
    // built-in JSONC parser is the standard-library reader for it.
    const oxlint = Bun.JSONC.parse(readFileSync(join(ROOT, oxlintConfig), "utf8")) as OxlintConfig;
    const plugins = (oxlint.jsPlugins ?? []).map((plugin) => plugin.replace(/^\.\//, ""));
    expect(plugins.length).toBeGreaterThan(0);

    const baselineScript = readFileSync(join(ROOT, "scripts/oxlint-baseline.sh"), "utf8");
    const baseline = /\$ROOT\/(scripts\/oxlint-baseline\.txt)/.exec(baselineScript)?.[1];
    expect(baseline).toBeDefined();

    const configs = [
      oxlintConfig,
      ...plugins,
      "tsconfig.json",
      ".oxfmtrc.json",
      ".editorconfig",
      baseline as string,
    ];
    const inputs = lintInputs();

    expect(configs.filter((config) => !existsSync(join(ROOT, config)))).toEqual([]);
    expect(configs.filter((config) => !coveredBy(inputs, config))).toEqual([]);
  });
});
