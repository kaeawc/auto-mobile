import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Visitor, type Expression } from "oxc-parser";
import { ENV_REGISTRY, readEnvRaw, readEnvTrimmed, ENV } from "../../src/config/env";
import { parseGuardSource, relativePosix, typeScriptFiles } from "./astGuard";

/**
 * #11848: every environment variable read in src/ must be declared in
 * src/config/env.ts. Unmigrated reads are listed in env-registry-baseline.txt
 * as `<file>\t<NAME>` lines; the list may only shrink. Regenerate after
 * migrating with `UPDATE_ENV_REGISTRY_BASELINE=1 bun test test/lint/envRegistry.test.ts`
 * (refuses to add entries; `=grow` is for the initial seeding only).
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const SRC = path.join(ROOT, "src");
const REGISTRY_FILE = "src/config/env.ts";
const BASELINE = path.join(import.meta.dir, "env-registry-baseline.txt");
const DOCS = path.join(ROOT, "docs/using/environment-variables.md");
const PRODUCT_NAME = /^(?:AUTOMOBILE_|AUTO_MOBILE_)[A-Z0-9_]+$/;
/** The registry table itself (`ENV.DATA_DIR`) is not an environment object. */
const REGISTRY_IDENTIFIER = "ENV";
const ENV_OBJECT = /(?:^|[a-z])(?:env|environment)$/i;

function staticName(node: Expression): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return node.type === "TemplateLiteral" && node.expressions.length === 0
    ? node.quasis[0].value.cooked
    : undefined;
}

function isEnvObject(node: Expression): boolean {
  switch (node.type) {
    case "Identifier":
      return node.name !== REGISTRY_IDENTIFIER && ENV_OBJECT.test(node.name);
    case "MemberExpression":
      return (
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name !== REGISTRY_IDENTIFIER &&
        ENV_OBJECT.test(node.property.name)
      );
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
      return isEnvObject(node.expression);
    default:
      return false;
  }
}

/** Statically named reads of `env.X`, `env["X"]`, `const { X } = env`, plus AUTOMOBILE_ literals. */
function findEnvNames(file: string, source: string): Set<string> {
  const names = new Set<string>();
  const callees = new Set<unknown>();
  new Visitor({
    CallExpression(node) {
      // `rangeEndEnv.trim()` calls a method on a string; it does not read a variable.
      callees.add(node.callee);
    },
    MemberExpression(node) {
      if (callees.has(node) || !isEnvObject(node.object)) {
        return;
      }
      const name = node.computed
        ? staticName(node.property as Expression)
        : node.property.type === "Identifier"
          ? node.property.name
          : undefined;
      if (name) {
        names.add(name);
      }
    },
    VariableDeclarator(node) {
      if (node.id.type === "ObjectPattern" && node.init && isEnvObject(node.init)) {
        for (const property of node.id.properties) {
          if (property.type === "Property" && !property.computed) {
            const key = property.key;
            if (key.type === "Identifier") {
              names.add(key.name);
            } else if (key.type === "Literal" && typeof key.value === "string") {
              names.add(key.value);
            }
          }
        }
      }
    },
    Literal(node) {
      if (typeof node.value === "string" && PRODUCT_NAME.test(node.value)) {
        names.add(node.value);
      }
    },
  }).visit(parseGuardSource(file, source));
  return names;
}

function registeredNames(): Set<string> {
  return new Set(ENV_REGISTRY.flatMap((spec) => [spec.name, spec.legacyName ?? spec.name]));
}

function readBaseline(): string[] {
  return readFileSync(BASELINE, "utf8")
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function unregisteredReads(files: Map<string, string>): string[] {
  const registered = registeredNames();
  return [...files]
    .filter(([relative]) => relative !== REGISTRY_FILE)
    .flatMap(([relative, source]) =>
      [...findEnvNames(relative, source)]
        .filter((name) => !registered.has(name))
        .map((name) => `${relative}\t${name}`),
    )
    .sort();
}

describe("environment variable registry", () => {
  let found: string[];
  // The AST scan of src/ runs in the hook so the per-test 100 ms budget is not spent on it.
  beforeAll(() => {
    found = unregisteredReads(
      new Map(
        typeScriptFiles(SRC).map((file) => [relativePosix(ROOT, file), readFileSync(file, "utf8")]),
      ),
    );
  }, 60_000);

  test("every env read in src/ is registered or on the shrink-only baseline", () => {
    if (process.env.UPDATE_ENV_REGISTRY_BASELINE) {
      const existing = new Set(readBaseline());
      const grown = found.filter((entry) => !existing.has(entry));
      if (process.env.UPDATE_ENV_REGISTRY_BASELINE !== "grow") {
        expect(grown, "Register these variables in src/config/env.ts instead.").toEqual([]);
      }
      writeFileSync(BASELINE, `${[...found].join("\n")}\n`);
      return;
    }
    const baseline = new Set(readBaseline());
    expect(
      found.filter((entry) => !baseline.has(entry)),
      "Unregistered environment read(s): declare the variable in src/config/env.ts and read it through readEnvTrimmed/readEnvRaw.",
    ).toEqual([]);
    expect(
      [...baseline].filter((entry) => !found.includes(entry)),
      "Stale baseline entries: rerun with UPDATE_ENV_REGISTRY_BASELINE=1 to shrink it.",
    ).toEqual([]);
  });

  test("baseline is sorted and has no duplicates", () => {
    const baseline = readBaseline();
    expect(baseline).toEqual([...new Set(baseline)].sort());
  });

  test("detector recognises dotted, bracket, destructured and literal forms", () => {
    const found = findEnvNames(
      "x.ts",
      `const a = process.env.DOT; const b = env["BRACKET"]; const { DESTRUCTURED, "QUOTED": q } = process.env;
       const c = deps.env.NESTED; const g = ENV.REGISTRY; rangeEnv.trim(); const d = "AUTOMOBILE_LITERAL"; const e = "NOT_A_PRODUCT_LITERAL"; const f = other.PLAIN;`,
    );
    expect([...found].sort()).toEqual([
      "AUTOMOBILE_LITERAL",
      "BRACKET",
      "DESTRUCTURED",
      "DOT",
      "NESTED",
      "QUOTED",
    ]);
  });

  test("registry entries are unique, documented and listed in the environment docs", () => {
    const names = ENV_REGISTRY.flatMap((spec) =>
      spec.legacyName ? [spec.name, spec.legacyName] : [spec.name],
    );
    expect(new Set(names).size).toBe(names.length);
    const docs = readFileSync(DOCS, "utf8");
    const missing = names.filter((name) => !docs.includes(`\`${name}\``));
    expect(missing, `Add to ${path.relative(ROOT, DOCS)}`).toEqual([]);
    for (const spec of ENV_REGISTRY) {
      expect(spec.doc.length).toBeGreaterThan(0);
      expect(spec.default.length).toBeGreaterThan(0);
    }
  });

  test("readers prefer the canonical name, fall back to the legacy one, and trim", () => {
    expect(readEnvTrimmed(ENV.DATA_DIR, { AUTO_MOBILE_DATA_DIR: " /legacy " })).toBe("/legacy");
    expect(
      readEnvTrimmed(ENV.DATA_DIR, { AUTOMOBILE_DATA_DIR: "/new", AUTO_MOBILE_DATA_DIR: "/old" }),
    ).toBe("/new");
    // An empty canonical value shadows the legacy twin (historic `??` precedence).
    expect(
      readEnvTrimmed(ENV.DATA_DIR, { AUTOMOBILE_DATA_DIR: "", AUTO_MOBILE_DATA_DIR: "/old" }),
    ).toBeUndefined();
    expect(readEnvRaw(ENV.LOG_DIR, { AUTOMOBILE_LOG_DIR: "  " })).toBe("  ");
    expect(readEnvTrimmed(ENV.LOG_DIR, {})).toBeUndefined();
  });
});
