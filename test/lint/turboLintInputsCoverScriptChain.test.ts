import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("turbo lint inputs cover the shell script chain", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  interface TurboConfig {
    readonly tasks: Record<string, { readonly inputs?: readonly string[] }>;
  }

  function loadTurbo(): TurboConfig {
    return JSON.parse(readFileSync(join(ROOT, "turbo.json"), "utf8")) as TurboConfig;
  }

  function referencedShellScripts(source: string): string[] {
    return [...source.matchAll(/\bbash\s+["']?(scripts\/[^\s"']+\.sh)/g)].map((match) => match[1]);
  }

  function coveredBy(inputs: readonly string[], path: string): boolean {
    return inputs.some((input) => {
      if (input === path) {
        return true;
      }
      if (input.endsWith("/**")) {
        return path.startsWith(input.slice(0, -1));
      }
      if (input.endsWith("/**/*.sh")) {
        const prefix = input.slice(0, -"**/*.sh".length);
        return path.startsWith(prefix) && path.endsWith(".sh");
      }
      if (input.endsWith("/*.sh")) {
        const prefix = input.slice(0, -"*.sh".length);
        return (
          path.startsWith(prefix) &&
          path.endsWith(".sh") &&
          !path.slice(prefix.length).includes("/")
        );
      }
      return false;
    });
  }

  test("every shell script in the lint chain exists and invalidates lint", () => {
    const lintScript = "scripts/lint.sh";
    const boundaryScript = "scripts/check-boundaries.sh";
    const referenced = [
      ...referencedShellScripts(readFileSync(join(ROOT, lintScript), "utf8")),
      ...referencedShellScripts(readFileSync(join(ROOT, boundaryScript), "utf8")),
    ];
    const scripts = [...new Set([lintScript, boundaryScript, ...referenced])];
    const inputs = loadTurbo().tasks.lint?.inputs ?? [];

    expect(scripts.filter((script) => !existsSync(join(ROOT, script)))).toEqual([]);
    expect(scripts.filter((script) => !coveredBy(inputs, script))).toEqual([]);
  });
});
