import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeShellDocument, FakeShellWindow } from "../fakes/FakeShellDom";
/**
 * The release build minifies identifiers (build.ts), and the shell script is assembled from
 * `Function.prototype.toString`, so the boot call must follow the renamed functions (#4682).
 */
test("the minified build of the shell still boots", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../src/server/observeAppShell.ts")],
    minify: true,
    target: "bun",
    format: "esm",
  });
  const text = await built.outputs[0].text();
  const dir = mkdtempSync(join(tmpdir(), "shellmin-"));
  const file = join(dir, "shell.mjs");
  writeFileSync(file, text);
  const mod = await import(file);
  const script: string = mod.observeAppShellScript();
  const win = new FakeShellWindow();
  const doc = new FakeShellDocument();
  new Function("window", "document", script)(win, doc);
  expect(win.methods).toEqual(["ui/initialize"]);
});
