import { describe, expect, test } from "bun:test";
import { parseGuardSource } from "./astGuard";
import { collectSourceFacts } from "./sourceFacts";

const facts = (source: string) => collectSourceFacts(parseGuardSource("fixture.ts", source));

describe("collectSourceFacts (mutations the guards rely on)", () => {
  test("module specifiers cover static, dynamic, re-export and require forms", () => {
    expect(
      facts(
        `import a from "s1"; import type { T } from "s2"; export * from "s3";
         export { x } from "s4"; const m = await import("s5"); const r = require("s6");`,
      ).moduleSpecifiers.sort(),
    ).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
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
  });

  test("an unknown method fails loudly", () => {
    expect(() => scoped({ method: "missing" })).toThrow("method missing not found");
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
