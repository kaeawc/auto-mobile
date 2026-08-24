import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const reproDir = "docs/reproductions/sharp-bun-035";

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf-8");
}

describe("sharp 0.35.x Bun repro artifact", () => {
  test("is a standalone package with no AutoMobile dependencies", async () => {
    const packageJson = JSON.parse(await readRepoFile(`${reproDir}/package.json`)) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.scripts?.repro).toBe("bun run index.ts");
    expect(packageJson.dependencies).toEqual({ sharp: "0.35.3" });
    expect(packageJson.devDependencies ?? {}).toEqual({});
  });

  test("documents upstream filing targets and captured local result", async () => {
    const readme = await readRepoFile(`${reproDir}/README.md`);
    const script = await readRepoFile(`${reproDir}/index.ts`);
    const lockfile = await readRepoFile(`${reproDir}/bun.lock`);
    const designDoc = await readRepoFile("docs/design-docs/image-backend.md");
    const validationScript = await readRepoFile("scripts/validate-sharp-bun-repro.sh");

    expect(readme).toContain("https://github.com/oven-sh/bun/issues/20372");
    expect(readme).toContain("https://github.com/oven-sh/bun/issues/29352");
    expect(readme).toContain("https://github.com/lovell/sharp/issues/4042");
    expect(readme).toContain("bash scripts/validate-sharp-bun-repro.sh");
    expect(readme).toContain("scratch/sharp-bun-0.35-repro");
    expect(readme).toContain("bun run repro");
    expect(readme).toContain("darwin arm64");
    expect(readme).toContain("Docker daemon was");

    expect(script).toContain('import sharp from "sharp"');
    expect(script).toContain("sharp.versions");
    expect(script).toContain("nearLossless");
    expect(script).not.toContain("@kaeawc/auto-mobile");

    expect(lockfile).toContain('"sharp": "0.35.3"');
    expect(lockfile).not.toContain("@kaeawc/auto-mobile");

    expect(validationScript).toContain("bun install --frozen-lockfile");
    expect(validationScript).toContain("bun run repro");
    expect(validationScript).toContain('"format": "webp"');
    expect(validationScript).toContain('"nearLossless": [1-9][0-9]*');

    expect(designDoc).toContain("Issue #3014 upstream repro record");
    expect(designDoc).toContain("docs/reproductions/sharp-bun-035");
    expect(designDoc).toContain("bash scripts/validate-sharp-bun-repro.sh");
    expect(designDoc).toContain("not a Linux/Windows crash log");
  });
});
