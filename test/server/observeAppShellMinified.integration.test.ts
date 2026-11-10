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

test("the minified build of the interactive picker (#17767) still boots", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../src/server/observeAppShell.ts")],
    minify: true,
    target: "bun",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "pickermin-"));
  const file = join(dir, "shell.mjs");
  writeFileSync(file, await built.outputs[0].text());
  const mod = await import(file);
  const win = new FakeShellWindow();
  const doc = new FakeShellDocument();
  new Function("window", "document", mod.observeAppShellScript("interactive"))(win, doc);
  win.deliver({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { viewHierarchy: { text: "OK", bounds: [0, 0, 9, 9] } } },
  });
  expect(win.methods).toEqual(["ui/initialize", "ui/notifications/size-changed"]);
  expect(doc.canvas.children.some((child) => child.attributes.get("id") === "picks")).toBe(true);
});
