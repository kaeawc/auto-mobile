import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("a bundled installed client reports its own manifest version from an unrelated cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "automobile-package-version-"));
  try {
    const packageDir = join(root, "node_modules/@kaeawc/auto-mobile");
    const hostDir = join(root, "host");
    await mkdir(packageDir, { recursive: true });
    await mkdir(hostDir);
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@kaeawc/auto-mobile", version: "0.0.69" }),
    );
    await writeFile(
      join(hostDir, "package.json"),
      JSON.stringify({ name: "unrelated-host", version: "0.0.68" }),
    );
    const entrypoint = join(root, "entry.ts");
    const versionModule = resolve(import.meta.dir, "../../src/utils/mcpVersion.ts");
    await writeFile(
      entrypoint,
      `import { getMcpServerVersion } from ${JSON.stringify(versionModule)};
console.log(getMcpServerVersion());`,
    );
    const build = await Bun.build({
      entrypoints: [entrypoint],
      outdir: join(packageDir, "dist/src"),
      target: "bun",
      format: "esm",
      minify: true,
    });
    expect(build.success).toBe(true);
    for (const inheritedVersion of ["0.0.68", ""]) {
      const child = Bun.spawn([process.execPath, build.outputs[0].path], {
        cwd: hostDir,
        env: { ...process.env, MCP_SERVER_VERSION: "", npm_package_version: inheritedVersion },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("0.0.69");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
