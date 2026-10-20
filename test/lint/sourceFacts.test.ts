import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useScratchRoot } from "../helpers/scratchRoot";
import {
  createGuardSourceReader,
  guardDirectoryEntries,
  parseGuardSource,
  readGuardFile,
  typeScriptFiles,
  guardTextMayMatch,
  GuardVisitor,
} from "./astGuard";
import type { VisitorObject } from "oxc-parser";
import { collectSourceFacts } from "./sourceFacts";

const facts = (source: string) => collectSourceFacts(parseGuardSource("fixture.ts", source));

describe("collectSourceFacts (mutations the guards rely on)", () => {
  const scratch = useScratchRoot("ast-guard-cache-");
  test.each(["win32", "darwin"] as const)(
    "guard source reader handles unchanged stat identity on %s",
    (platform) => {
      let source = 'import "s1";';
      let reads = 0;
      const stat = { dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n, size: 12n };
      const read = createGuardSourceReader({
        platform,
        stat: () => stat,
        readFile: () => {
          reads++;
          return source;
        },
      });
      expect(read("fixture.ts")).toBe(source);
      expect(read("fixture.ts")).toBe(source);
      source = 'import "s2";';
      expect(read("fixture.ts")).toBe(platform === "win32" ? source : 'import "s1";');
      expect(reads).toBe(platform === "win32" ? 3 : 1);
      stat.ctimeNs++;
      expect(read("fixture.ts")).toBe(source);
      expect(reads).toBe(platform === "win32" ? 4 : 2);
    },
  );

  test("module specifiers cover static, dynamic, re-export and require forms", () => {
    expect(
      facts(
        `import a from "s1"; import type { T } from "s2"; export * from "s3";
         export { x } from "s4"; const m = await import("s5"); const r = require("s6");`,
      ).moduleSpecifiers.sort(),
    ).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);

    // Exercise the inventory -> source -> facts pipeline against mutable scanner fixtures.
    const root = scratch.next();
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    expect(typeScriptFiles(root)).toEqual([]);
    const file = path.join(nested, "source.ts");
    writeFileSync(file, 'import "s1";');
    utimesSync(file, 0, 0);
    expect(typeScriptFiles(root)).toEqual([file]);
    expect(facts(readGuardFile(file)).moduleSpecifiers).toEqual(["s1"]);
    expect(readGuardFile(pathToFileURL(file))).toBe(readGuardFile(file));
    // Same size and restored mtime: re-read on Windows, use ctime elsewhere.
    writeFileSync(file, 'import "s2";');
    utimesSync(file, 0, 0);
    expect(facts(readGuardFile(file)).moduleSpecifiers).toEqual(["s2"]);
    const replacement = path.join(nested, "replacement.ts");
    writeFileSync(replacement, 'import "s3";');
    utimesSync(replacement, 0, 0);
    renameSync(replacement, file);
    expect(facts(readGuardFile(file)).moduleSpecifiers).toEqual(["s3"]);
    const files = typeScriptFiles(root);
    files.pop();
    expect(typeScriptFiles(root)).toEqual([file]);
    const entries = guardDirectoryEntries(root);
    entries.pop();
    expect(guardDirectoryEntries(root).map((entry) => entry.name)).toEqual(["nested"]);
    const renamed = path.join(nested, "renamed.ts");
    renameSync(file, renamed);
    expect(typeScriptFiles(root)).toEqual([renamed]);
    rmSync(renamed);
    expect(typeScriptFiles(root)).toEqual([]);
    expect(() => readGuardFile(renamed)).toThrow();
  });

  test("template-literal and import-equals specifiers are recorded", () => {
    expect(
      facts(
        'const a = import(`t1`); const b = require(`t2`); import c = require("t3");',
      ).moduleSpecifiers.sort(),
    ).toEqual(["t1", "t2", "t3"]);
  });

  test("a mention in a comment or string is not a module specifier", () => {
    expect(
      facts(`// import "@jimp/wasm-webp"\nconst s = "@jimp/wasm-webp";`).moduleSpecifiers,
    ).toEqual([]);
  });

  test("string literals expose a specifier that is only reachable through a variable", () => {
    const source = `const name = "@jimp/wasm-webp"; await import(name); const t = \`@jimp/wasm-\${"webp"}\`;`;
    const parsed = facts(source);
    // The specifier list cannot see an indirect import, the literal list can.
    expect(parsed.moduleSpecifiers).toEqual([]);
    expect(parsed.stringLiterals).toContain("@jimp/wasm-webp");
  });

  test("a string literal in a comment is not recorded", () => {
    expect(facts(`// "@jimp/wasm-webp"\nconst x = 1;`).stringLiterals).toEqual([]);
  });

  test("imported value names are resolved, type imports excluded", () => {
    const { importedNames } = facts(
      `import { A, type B, C as D } from "m"; import type { E } from "m"; import * as N from "n";`,
    );
    expect(importedNames).toEqual(["A@m", "C@m", "*@n"]);
  });

  test("declarations are found in every form and at any depth", () => {
    const { declaredNames } = facts(
      `const a = 1; let b; var c; function d() {} class e {} function f() { const g = 1; }`,
    );
    expect(declaredNames).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  test("calls include globalThis-qualified names but not other receivers", () => {
    const { calledNames } = facts(
      `encodeURIComponent(a); globalThis.encodeURIComponent(b); (0, encodeURIComponent)(c); other.encodeURIComponent(d);`,
    );
    expect(calledNames.filter((name) => name === "encodeURIComponent")).toHaveLength(3);
  });

  test("typeof comparisons are matched on either side and either operator", () => {
    const { typeofComparisons } = facts(
      `typeof result.stdout === "string"; "string" == typeof result.stderr; typeof x === "string";`,
    );
    expect(typeofComparisons).toEqual(["result.stdout===string", "result.stderr===string"]);
  });
});

describe("collectSourceFacts scoping and call facts", () => {
  const source = `class A {
    one() { this.daemonManager.restart(); }
    two() { serverConfig.isFooEnabled(); isDebugModeEnabled(); }
    three() { other.kill(); }
  }`;
  const scoped = (options: Parameters<typeof collectSourceFacts>[1]) =>
    collectSourceFacts(parseGuardSource("a.ts", source), options);

  test("method scope sees only that method's calls and identifiers", () => {
    const two = scoped({ method: "two" });
    expect(two.calledMembers).toEqual(["serverConfig.isFooEnabled"]);
    expect(two.calledNames).toContain("isDebugModeEnabled");
    expect(two.calledMethodNames).toEqual(["isFooEnabled"]);
    expect(two.identifierNames).not.toContain("daemonManager");
  });

  test("between scope spans from one method start to the next, exclusive", () => {
    const span = scoped({ between: ["one", "three"] });
    expect(span.identifierNames).toContain("daemonManager");
    expect(span.calledMethodNames).toEqual(["restart", "isFooEnabled"]);
  });

  test("unscoped facts include property-name identifiers and any-receiver method calls", () => {
    const all = scoped(undefined);
    expect(all.identifierNames).toContain("daemonManager");
    expect(all.calledMethodNames).toContain("kill");

    const program = parseGuardSource("visitor.ts", "const x = 1;");
    const calls: string[] = [];
    let retained: VisitorObject = {};
    const visitor = new GuardVisitor(
      {
        Program() {
          calls.push("enter");
        },
        "Program:exit"() {
          calls.push("exit");
        },
      },
      (handlers) => {
        retained = handlers;
        return {
          visit(value) {
            handlers.Program?.(value);
            handlers["Program:exit"]?.(value);
          },
        };
      },
    );
    visitor.visit(program);
    expect(calls).toEqual(["enter", "exit"]);
    // Model Oxc's process-level cache keeping these forwarders after traversal.
    retained.Program?.(program);
    retained["Program:exit"]?.(program);
    expect(calls).toEqual(["enter", "exit"]);
    visitor.visit(program);
    expect(calls).toEqual(["enter", "exit", "enter", "exit"]);

    let retainedThrow: VisitorObject = {};
    const failing = new GuardVisitor(
      {
        Program() {
          throw new Error("scanner failure");
        },
      },
      (handlers) => {
        retainedThrow = handlers;
        return {
          visit(value) {
            handlers.Program?.(value);
          },
        };
      },
    );
    expect(() => failing.visit(program)).toThrow("scanner failure");
    expect(() => retainedThrow.Program?.(program)).not.toThrow();

    const nested: string[] = [];
    const inner = new GuardVisitor({
      Program() {
        nested.push("inner");
      },
    });
    const outer = new GuardVisitor({
      Program() {
        nested.push("outer");
        inner.visit(program);
        nested.push("outer exit");
      },
    });
    outer.visit(program);
    expect(nested).toEqual(["outer", "inner", "outer exit"]);
  });

  test("an unknown method fails loudly", () => {
    expect(() => scoped({ method: "missing" })).toThrow("method missing not found");
    expect(parseGuardSource("a.ts", "const unrelated = 1;", false)).toBeUndefined();
    expect(() => parseGuardSource("a.ts", "const =", false)).toThrow("a.ts:");
    for (const source of [
      String.raw`\u0061`,
      String.raw`\x61`,
      String.raw`\060`,
      String.raw`\a`,
      "\\\n",
    ]) {
      expect(guardTextMayMatch(source, /a/)).toBe(true);
    }
    for (const source of [
      String.raw`\n`,
      String.raw`\t`,
      String.raw`\r`,
      String.raw`\0`,
      String.raw`\\`,
      String.raw`\"`,
      String.raw`\/`,
    ]) {
      expect(guardTextMayMatch(source, /a/)).toBe(false);
    }
    expect(guardTextMayMatch(String.raw`device["statu\s"]`, /status/)).toBe(true);
    expect(guardTextMayMatch(String.raw`/\s+\d+/`, /sessionId|status/)).toBe(false);
    const stateful = /status/g;
    stateful.lastIndex = 42;
    expect(guardTextMayMatch("device.status", stateful)).toBe(true);
    expect(stateful.lastIndex).toBe(42);
  });
});

describe("collectSourceFacts receivers and private names", () => {
  test("member-call receivers use the last property segment; private names are identifiers", () => {
    const f = collectSourceFacts(
      parseGuardSource(
        "a.ts",
        `class A { #daemonManager = 1; m() { this.serverConfig.isXEnabled(); cfg.isYEnabled(); Bun.spawnSync(); } }`,
      ),
    );
    expect(f.calledMembers).toEqual(["serverConfig.isXEnabled", "cfg.isYEnabled", "Bun.spawnSync"]);
    expect(f.identifierNames).toContain("daemonManager");
    expect(f.calledMethodNames).toContain("spawnSync");
  });
});
