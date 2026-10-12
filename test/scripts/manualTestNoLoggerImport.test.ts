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
const entries = [
  "private-daemon.ts",
  "daemon-frame.ts",
  "aux-socket.ts",
  "proxy-session.ts",
  "python/harness-guard.ts",
];
let imports: ReadonlyMap<string, readonly string[]>;
beforeAll(() => {
  // AST parsing is an immutable suite fixture; per-test assertions do no filesystem work.
  imports = new Map(
    [...new Set([...readdirSync(root).filter((name) => name.endsWith(".ts")), ...entries])].map(
      (name) => {
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
      },
    ),
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
    expect(imports.get(entry)?.[0]).toBe(
      entry.startsWith("python/") ? "../harnessLogSink" : "./harnessLogSink",
    );
  }
  expect(imports.get("harnessLogSink.ts")?.some((name) => name.includes("src/"))).toBe(false);
});
const fakeHomes = [resolve("/home/fake"), resolve("/home/account")];
const fakeFs = { realpath: (path: string) => resolve(path) };
test("sink selection matches the product resolver and restores every recorded change", () => {
  const env: Record<string, string | undefined> = { KEEP: "yes", AUTO_MOBILE_LOG_SINK: "file" };
  const overrides = selectHarnessLogSink(env, fakeHomes, fakeFs);
  expect(overrides).toEqual([{ name: "AUTOMOBILE_LOG_SINK", previous: undefined }]);
  expect(resolveAutomobileLogSink(env)).toBe("stderr");
  expect(harnessChildEnvironment(env, overrides)).toEqual({
    KEEP: "yes",
    AUTO_MOBILE_LOG_SINK: "file",
  });
  expect(env.AUTOMOBILE_LOG_SINK).toBe("stderr");
  expect(
    harnessChildEnvironment({ ...env, SECOND: "changed" }, [
      { name: "AUTOMOBILE_LOG_SINK", previous: "file" },
      { name: "SECOND", previous: undefined },
    ]),
  ).toEqual({ KEEP: "yes", AUTOMOBILE_LOG_SINK: "file", AUTO_MOBILE_LOG_SINK: "file" });
});
test("log sink decision is pure over supplied env homes and realpaths", () => {
  const cases: Array<[Record<string, string | undefined>, boolean]> = [
    [{}, true],
    [{ AUTOMOBILE_LOG_DIR: resolve("/home/fake/.auto-mobile/logs") }, true],
    [{ AUTOMOBILE_LOG_DIR: resolve("/home/account/.auto-mobile/logs") }, true],
    [{ AUTOMOBILE_LOG_DIR: "relative" }, true],
    [{ AUTOMOBILE_LOG_DIR: resolve("/private/logs") }, false],
    [{ AUTOMOBILE_LOG_DIR: resolve("/home/fake/.auto-mobile-other") }, false],
    [{ AUTOMOBILE_LOG_SINK: "file" }, true],
    [{ AUTOMOBILE_LOG_SINK: "bogus" }, true],
    [{ AUTOMOBILE_LOG_SINK: "both" }, true],
    [{ AUTOMOBILE_LOG_SINK: "", AUTO_MOBILE_LOG_SINK: "stderr" }, true],
    [{ AUTOMOBILE_LOG_DIR: resolve("/home/fake/other/../.auto-mobile/logs") }, true],
    [{ AUTOMOBILE_LOG_DIR: "bad\0path" }, true],
    [{ AUTOMOBILE_LOG_SINK: "stderr" }, false],
    [{ AUTOMOBILE_LOG_SINK: " STDERR " }, false],
    [{ AUTO_MOBILE_LOG_SINK: "stderr" }, false],
    [{ AUTO_MOBILE_LOG_SINK: "bogus" }, true],
    [{ AUTO_MOBILE_LOG_SINK: "file" }, true],
    [{ AUTOMOBILE_LOG_SINK: "bogus", AUTO_MOBILE_LOG_SINK: "stderr" }, true],
    [{ AUTO_MOBILE_LOG_DIR: resolve("/private/logs") }, false],
    [{ AUTO_MOBILE_LOG_DIR: resolve("/home/fake/.auto-mobile/logs") }, true],
    [{ AUTOMOBILE_LOG_DIR: "", AUTO_MOBILE_LOG_DIR: resolve("/private/logs") }, true],
    [
      {
        AUTOMOBILE_LOG_DIR: resolve("/private/logs"),
        AUTO_MOBILE_LOG_DIR: resolve("/home/fake/.auto-mobile/logs"),
      },
      false,
    ],
    [{ AUTOMOBILE_LOG_SINK: "file", AUTOMOBILE_LOG_DIR: resolve("/private/logs") }, false],
    [{ AUTOMOBILE_LOG_SINK: "bogus", AUTOMOBILE_LOG_DIR: resolve("/private/logs") }, false],
    [{ AUTOMOBILE_DATA_DIR: resolve("/private/data") }, true],
    [{ AUTO_MOBILE_DATA_DIR: resolve("/private/data") }, true],
    [
      {
        AUTOMOBILE_LOG_DIR: resolve("/private/logs"),
        AUTOMOBILE_DATA_DIR: resolve("/home/fake/.auto-mobile"),
      },
      false,
    ],
  ];
  for (const [input, forced] of cases) {
    const env = { ...input };
    const selected = selectHarnessLogSink(env, fakeHomes, fakeFs);
    expect(selected.length > 0).toBe(forced);
    expect(harnessChildEnvironment(env, selected)).toEqual(input);
    expect(resolveAutomobileLogSink(env)).toBe(forced ? "stderr" : resolveAutomobileLogSink(input));
  }
});
test("log sink refuses symlink ancestors and unresolvable paths", () => {
  const aliases = new Map([
    [resolve("/alias"), resolve("/home/account/.auto-mobile")],
    [resolve("/home/fake"), resolve("/real-home")],
  ]);
  const fs = {
    realpath(path: string): string {
      if (
        path === resolve("/alias/missing/logs") ||
        path === resolve("/alias/missing") ||
        path === resolve("/home/fake/.auto-mobile")
      ) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return aliases.get(path) ?? path;
    },
  };
  for (const directory of [
    resolve("/alias/missing/logs"),
    resolve("/real-home/.auto-mobile/logs"),
  ]) {
    const env = { AUTOMOBILE_LOG_DIR: directory };
    expect(selectHarnessLogSink(env, fakeHomes, fs)).toHaveLength(1);
    expect(resolveAutomobileLogSink(env)).toBe("stderr");
  }
  for (const code of ["EACCES", "ELOOP", "ENOENT"]) {
    const env = { AUTOMOBILE_LOG_DIR: resolve("/unresolvable/logs") };
    expect(
      selectHarnessLogSink(env, fakeHomes, {
        realpath: () => {
          throw Object.assign(new Error(code), { code });
        },
      }),
    ).toHaveLength(1);
  }
  expect(
    selectHarnessLogSink({ AUTOMOBILE_LOG_DIR: resolve("/private/logs") }, [], fakeFs),
  ).toHaveLength(1);
});
test("F1 bogus log sink without a directory is forced to stderr", () => {
  const env = { AUTOMOBILE_LOG_SINK: "bogus" };
  selectHarnessLogSink(env, fakeHomes, fakeFs);
  expect(resolveAutomobileLogSink(env)).toBe("stderr");
});

test("log sink preserves caller stderr without filesystem queries", () => {
  const env = {
    AUTO_MOBILE_LOG_SINK: " STDERR ",
    AUTOMOBILE_LOG_DIR: resolve("/home/fake/.auto-mobile/logs"),
  };
  expect(
    selectHarnessLogSink(env, fakeHomes, {
      realpath: () => {
        throw new Error("must not query");
      },
    }),
  ).toEqual([]);
  expect(env).toEqual({
    AUTO_MOBILE_LOG_SINK: " STDERR ",
    AUTOMOBILE_LOG_DIR: resolve("/home/fake/.auto-mobile/logs"),
  });
});
test("log sink allows a missing private leaf and rejects a canonical default-root alias", () => {
  const fs = {
    realpath(path: string): string {
      if (path === resolve("/private/new/logs") || path === resolve("/private/new")) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return path === resolve("/home/account/.auto-mobile") ? resolve("/aliased-default") : path;
    },
  };
  expect(
    selectHarnessLogSink({ AUTOMOBILE_LOG_DIR: resolve("/private/new/logs") }, fakeHomes, fs),
  ).toEqual([]);
  expect(
    selectHarnessLogSink({ AUTOMOBILE_LOG_DIR: resolve("/aliased-default/logs") }, fakeHomes, fs),
  ).toHaveLength(1);
});
