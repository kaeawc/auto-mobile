import { beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { resolveModule } from "../lint/moduleExportResolver";
import { resolveAutomobileLogSink } from "../../src/utils/loggingConfig";
import {
  selectHarnessLogSink,
  harnessChildEnvironment,
} from "../../scripts/manual-test/harnessLogSink";

const root = resolve(import.meta.dir, "../../scripts/manual-test");
const entries = ["private-daemon.ts", "daemon-frame.ts", "aux-socket.ts", "proxy-session.ts"];
let imports: ReadonlyMap<string, readonly string[]>;
beforeAll(() => {
  // AST parsing is an immutable suite fixture; per-test assertions do no filesystem work.
  imports = new Map(
    readdirSync(root)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => {
        const ast = ts.createSourceFile(
          name,
          readFileSync(resolve(root, name), "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        const modules = ast.statements
          .filter(ts.isImportDeclaration)
          .map((node) =>
            ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "",
          );
        return [name, Object.freeze(modules)] as const;
      }),
  );
});
test("no harness module directly imports the product logger", () => {
  const logger = resolve(root, "../../src/utils/logger.ts");
  const known = new Set([logger]);
  for (const [file, modules] of imports) {
    expect(modules.some((name) => resolveModule(resolve(root, file), name, known) === logger)).toBe(
      false,
    );
  }
});
test("every entry imports the isolated sink first and the sink has no src imports", () => {
  for (const entry of entries) {
    expect(imports.get(entry)?.[0]).toBe("./harnessLogSink");
  }
  expect(imports.get("harnessLogSink.ts")?.some((name) => name.includes("src/"))).toBe(false);
});
test("sink selection matches the exported product resolver and undoes only its override", () => {
  const env: Record<string, string | undefined> = { KEEP: "yes" };
  const override = selectHarnessLogSink(env);
  expect(override).toEqual({ name: "AUTOMOBILE_LOG_SINK", previous: undefined });
  expect(resolveAutomobileLogSink(env)).toBe("stderr");
  expect(harnessChildEnvironment(env, override)).toEqual({ KEEP: "yes" });
  expect(env.AUTOMOBILE_LOG_SINK).toBe("stderr");
  expect(
    harnessChildEnvironment(env, { name: "AUTOMOBILE_LOG_SINK", previous: "file" })
      .AUTOMOBILE_LOG_SINK,
  ).toBe("file");
});
test("explicit sink spellings and private log dir keep caller choices", () => {
  for (const env of [
    { AUTOMOBILE_LOG_SINK: "both" },
    { AUTO_MOBILE_LOG_SINK: "stderr" },
    { AUTOMOBILE_LOG_DIR: "/private/logs" },
  ]) {
    expect(selectHarnessLogSink(env)).toBeUndefined();
    expect(harnessChildEnvironment(env)).toEqual(env);
  }
});
