import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import { type AssignmentTargetMaybeDefault, type Expression } from "oxc-parser";
import {
  AMBIENT_ENV,
  AMBIENT_ENV_REGISTRY,
  ENV_REGISTRY,
  readEnvRaw,
  readEnvTrimmed,
  ENV,
} from "../../src/config/env";
import type { EnvVarSpec } from "../../src/config/envSpec";
import {
  parseGuardSource,
  relativePosix,
  typeScriptFiles,
  readGuardFile,
  guardTextMayMatch,
  unwrapCallee,
  GuardVisitor as Visitor,
} from "./astGuard";

/**
 * #11848: every environment variable read in src/ must be declared in
 * src/config/env.ts. There is no baseline: any unregistered read is a failure.
 */
const ROOT = path.resolve(import.meta.dir, "../..");
const SRC = path.join(ROOT, "src");
const REGISTRY_FILE = "src/config/env.ts";
/** The one module allowed raw name-based `process.env[name]` lookups (#14404). */
const PROCESS_ENVIRONMENT_ADAPTER = "src/config/processEnvironment.ts";
const DOCS = path.join(ROOT, "docs/using/environment-variables.md");
const PRODUCT_NAME = /^(?:AUTOMOBILE_|AUTO_MOBILE_)[A-Z0-9_]+$/;
/** The registry table itself (`ENV.DATA_DIR`) is not an environment object. */
const REGISTRY_IDENTIFIER = "ENV";
const ENV_OBJECT = /(?:^|[a-z])(?:env|environment)$/i;

/**
 * `AUTOMOBILE_*`-shaped string literals that are not environment variables. They match the
 * product-name scan but are never read from an environment object; renaming them would change
 * on-device shell output or user-facing error codes.
 */
const NON_ENV_LITERALS: Readonly<Record<string, string>> = {
  AUTOMOBILE_INCOMPLETE_EXTRACTION:
    "Error code for an incomplete package extraction, not a variable.",
  AUTOMOBILE_APP_FILE_BACKUP: "Marker echoed by the on-device app-file backup shell script.",
  AUTOMOBILE_APP_FILE_DESTINATION_IS_DIRECTORY:
    "Marker echoed by the on-device app-file save shell script.",
  AUTOMOBILE_SHARED_STORAGE_BACKUP: "Marker echoed by the on-device shared-storage backup script.",
};

function staticName(node: Expression): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return node.type === "TemplateLiteral" && node.expressions.length === 0
    ? (node.quasis[0].value.cooked ?? undefined)
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
  const program = parseGuardSource(
    file,
    source,
    guardTextMayMatch(source, /env|AUTOMOBILE_|AUTO_MOBILE_/i),
  );
  if (!program) {
    return names;
  }
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
  }).visit(program);
  return names;
}

function isProcessEnv(node: Expression): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    node.property.type === "Identifier" &&
    node.property.name === "env"
  );
}

/** Registered names read straight off `process.env` instead of through readEnvRaw/readEnvTrimmed. */
function rawProcessEnvReads(file: string, source: string, registered: Set<string>): string[] {
  const hits: string[] = [];
  const program = parseGuardSource(
    file,
    source,
    guardTextMayMatch(source, "process") && guardTextMayMatch(source, "env"),
  );
  if (!program) {
    return hits;
  }
  new Visitor({
    VariableDeclarator(node) {
      // `const { HOME } = process.env` is a raw read exactly like `process.env.HOME`.
      if (node.id.type !== "ObjectPattern" || !node.init || !isProcessEnv(node.init)) {
        return;
      }
      for (const property of node.id.properties) {
        if (property.type !== "Property" || property.computed) {
          continue;
        }
        const key = property.key;
        const name =
          key.type === "Identifier"
            ? key.name
            : key.type === "Literal" && typeof key.value === "string"
              ? key.value
              : undefined;
        if (name && registered.has(name)) {
          hits.push(`${file}\t${name}`);
        }
      }
    },
    MemberExpression(node) {
      if (!isProcessEnv(node.object)) {
        return;
      }
      const name = node.computed
        ? staticName(node.property as Expression)
        : node.property.type === "Identifier"
          ? node.property.name
          : undefined;
      if (name && registered.has(name)) {
        hits.push(`${file}\t${name}`);
      }
    },
  }).visit(program);
  return hits;
}

function registeredNames(): Set<string> {
  return new Set(
    [...ENV_REGISTRY, ...AMBIENT_ENV_REGISTRY].flatMap((spec) => [
      spec.name,
      spec.legacyName ?? spec.name,
    ]),
  );
}

/** Non-static keys hide constant names from the registered-name scan above. */
function computedProcessEnvReads(file: string, source: string): string[] {
  const hits: string[] = [];
  const program = parseGuardSource(
    file,
    source,
    guardTextMayMatch(source, "process") && guardTextMayMatch(source, "env"),
  );
  if (!program) {
    return hits;
  }
  const writes = new Set<unknown>();
  const markWrite = (target: AssignmentTargetMaybeDefault | Expression): void => {
    if (target.type === "ObjectPattern") {
      for (const property of target.properties) {
        markWrite(property.type === "RestElement" ? property.argument : property.value);
      }
    } else if (target.type === "ArrayPattern") {
      for (const element of target.elements) {
        if (element) {
          markWrite(element.type === "RestElement" ? element.argument : element);
        }
      }
    } else if (target.type === "AssignmentPattern") {
      markWrite(target.left);
    } else {
      const node = unwrapCallee(target);
      if (node.type === "ChainExpression") {
        markWrite(node.expression);
      } else {
        writes.add(node);
      }
    }
  };
  new Visitor({
    AssignmentExpression(node) {
      markWrite(node.left);
    },
    UpdateExpression(node) {
      markWrite(node.argument);
    },
    UnaryExpression(node) {
      if (node.operator === "delete") {
        markWrite(node.argument);
      }
    },
    ForInStatement(node) {
      if (node.left.type !== "VariableDeclaration") {
        markWrite(node.left);
      }
    },
    ForOfStatement(node) {
      if (node.left.type !== "VariableDeclaration") {
        markWrite(node.left);
      }
    },
    MemberExpression(node) {
      if (
        !writes.has(node) &&
        isProcessEnv(node.object) &&
        node.computed &&
        node.property.type !== "Literal" &&
        node.property.type !== "TemplateLiteral"
      ) {
        // Any non-static key hides its name: an identifier, or a member such as
        // `ENV.FOO.name` that the registered-name scan cannot resolve either (#14403).
        hits.push(`${file}\tprocess.env[${source.slice(node.property.start, node.property.end)}]`);
      }
    },
  }).visit(program);
  return hits;
}

const REGISTRY_TABLES: Readonly<Record<string, Readonly<Record<string, EnvVarSpec>>>> = {
  ENV,
  AMBIENT_ENV,
};
/** Readers that hand back the raw text, so a caller would have to supply its own truthiness rule. */
const TEXT_READERS = new Set(["readEnvRaw", "readEnvTrimmed"]);

/**
 * `readEnvRaw(ENV.X)` / `readEnvTrimmed(ENV.X)` where `ENV.X` is declared `kind: "bool"`: the
 * caller would compare the text itself, so `1`, `true` and `TRUE` stop meaning the same thing.
 */
function boolSpecTextReads(file: string, source: string): string[] {
  const hits: string[] = [];
  const program = parseGuardSource(file, source, guardTextMayMatch(source, /readEnv(Raw|Trimmed)/));
  if (!program) {
    return hits;
  }
  new Visitor({
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      const spec = node.arguments[0];
      if (
        callee.type !== "Identifier" ||
        !TEXT_READERS.has(callee.name) ||
        spec?.type !== "MemberExpression" ||
        spec.computed ||
        spec.object.type !== "Identifier" ||
        spec.property.type !== "Identifier"
      ) {
        return;
      }
      const table = REGISTRY_TABLES[spec.object.name];
      if (table && Object.hasOwn(table, spec.property.name)) {
        if (table[spec.property.name].kind === "bool") {
          hits.push(`${file}\t${callee.name}(${spec.object.name}.${spec.property.name})`);
        }
      }
    },
  }).visit(program);
  return hits;
}

function unregisteredReads(files: Map<string, string>): string[] {
  const registered = registeredNames();
  return [...files]
    .filter(([relative]) => relative !== REGISTRY_FILE)
    .flatMap(([relative, source]) =>
      [...findEnvNames(relative, source)]
        .filter((name) => !registered.has(name) && !Object.hasOwn(NON_ENV_LITERALS, name))
        .map((name) => `${relative}\t${name}`),
    )
    .sort();
}

describe("environment variable registry", () => {
  let found: string[];
  let rawReads: string[];
  let computedReads: string[];
  let allowlistedReads: string[];
  let boolTextReads: string[];
  // The AST scan of src/ runs in the hook so the per-test 100 ms budget is not spent on it.
  beforeAll(() => {
    const files = new Map(
      typeScriptFiles(SRC).map((file) => [relativePosix(ROOT, file), readGuardFile(file)]),
    );
    found = unregisteredReads(files);
    const registered = registeredNames();
    rawReads = [...files]
      .filter(([relative]) => relative !== REGISTRY_FILE)
      .flatMap(([relative, source]) => rawProcessEnvReads(relative, source, registered))
      .sort();
    computedReads = [...files]
      .filter(([relative]) => relative !== PROCESS_ENVIRONMENT_ADAPTER)
      .flatMap(([relative, source]) => computedProcessEnvReads(relative, source))
      .sort();
    const allowlisted = new Set(Object.keys(NON_ENV_LITERALS));
    allowlistedReads = [...files]
      .filter(([relative]) => relative !== REGISTRY_FILE)
      .flatMap(([relative, source]) => rawProcessEnvReads(relative, source, allowlisted));
    boolTextReads = [...files]
      .filter(([relative]) => !relative.startsWith("src/config/"))
      .flatMap(([relative, source]) => boolSpecTextReads(relative, source))
      .sort();
  }, 60_000);

  test("every env read in src/ is registered", () => {
    expect(
      found,
      "Unregistered environment read(s): declare the variable in src/config/env.ts and read it through readEnvTrimmed/readEnvRaw.",
    ).toEqual([]);
  });

  test("registered variables are read through the registry, never raw process.env", () => {
    expect(
      rawReads,
      "Read registered variables with readEnvRaw/readEnvTrimmed(spec) instead of process.env.X.",
    ).toEqual([]);
  });

  test("raw process.env detector flags registered names only", () => {
    const registered = new Set(["HOME"]);
    expect(
      rawProcessEnvReads(
        "x.ts",
        `process.env.HOME; process.env["HOME"]; process.env.OTHER; env.HOME;`,
        registered,
      ),
    ).toEqual(["x.ts\tHOME", "x.ts\tHOME"]);
  });

  test("computed reads use the environment registry outside the process environment adapter", () => {
    expect(
      computedReads,
      "Use readEnvRaw/readEnvTrimmed with an ENV spec instead of process.env[identifier].",
    ).toEqual([]);
  });

  test("computed process.env detector flags identifier reads", () => {
    expect(
      computedProcessEnvReads(
        "x.ts",
        `const KEY = "HOME"; process.env[KEY]; process.env?.[KEY];
         process.env["HOME"]; env[KEY]; process.env[\`DYNAMIC_\${platform}\`];`,
      ),
    ).toEqual(["x.ts\tprocess.env[KEY]", "x.ts\tprocess.env[KEY]"]);
  });

  test("computed process.env detector flags member-expression and other non-static keys (#14403)", () => {
    expect(
      computedProcessEnvReads(
        "x.ts",
        `process.env[WEBRTC_ENV.WHIP_ENDPOINT]; process.env[ENV.FOO.name];
         process.env[keyFor("x")]; process.env["STATIC"]; process.env[\`STATIC\`];`,
      ),
    ).toEqual([
      "x.ts\tprocess.env[WEBRTC_ENV.WHIP_ENDPOINT]",
      "x.ts\tprocess.env[ENV.FOO.name]",
      'x.ts\tprocess.env[keyFor("x")]',
    ]);
  });

  test("computed process.env detector allows writes and deletes but checks their values", () => {
    expect(
      computedProcessEnvReads(
        "x.ts",
        `process.env[KEY] = "value"; process.env[KEY] ??= "value";
         process.env[KEY] += "value"; process.env[KEY]++; delete process.env[KEY];
         delete process.env?.[KEY]; (process.env[KEY] as string) = "value";
         ({ value: process.env[KEY] = process.env[DEFAULT] } = values);
         [process.env[KEY], ...process.env[REST]] = values;
         for (process.env[KEY] of values) {} for (process.env[KEY] in values) {}
         process.env[KEY] = process.env[OTHER]; process.env[KEY].field = "value";`,
      ),
    ).toEqual(["x.ts\tprocess.env[DEFAULT]", "x.ts\tprocess.env[OTHER]", "x.ts\tprocess.env[KEY]"]);
  });

  test("raw process.env detector flags destructured reads", () => {
    const registered = new Set(["HOME", "PATH"]);
    expect(
      rawProcessEnvReads(
        "x.ts",
        `const { HOME, OTHER, "PATH": p } = process.env; const { HOME: h2 } = env;`,
        registered,
      ),
    ).toEqual(["x.ts\tHOME", "x.ts\tPATH"]);
  });

  test("allowlisted non-env literals are never read from process.env or registered", () => {
    const allowlisted = new Set(Object.keys(NON_ENV_LITERALS));
    expect(registeredNames().intersection(allowlisted).size).toBe(0);
    expect(allowlistedReads).toEqual([]);
    for (const reason of Object.values(NON_ENV_LITERALS)) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  test("bool variables are read with readEnvBool, never compared as text", () => {
    expect(
      boolTextReads,
      'Read kind: "bool" variables with readEnvBool(spec) so 1, true and TRUE all enable them.',
    ).toEqual([]);
  });

  test("bool text-read detector flags only bool specs passed to the text readers", () => {
    const boolKey = Object.entries(ENV).find(([, spec]) => spec.kind === "bool")?.[0];
    const textKey = Object.entries(ENV).find(([, spec]) => spec.kind === "path")?.[0];
    expect(boolKey && textKey).toBeTruthy();
    expect(
      boolSpecTextReads(
        "x.ts",
        `readEnvRaw(ENV.${boolKey}) === "1"; readEnvTrimmed(ENV.${boolKey}, env);
         readEnvBool(ENV.${boolKey}); readEnvRaw(ENV.${textKey}); readEnvRaw(OTHER.${boolKey});`,
      ),
    ).toEqual([`x.ts\treadEnvRaw(ENV.${boolKey})`, `x.ts\treadEnvTrimmed(ENV.${boolKey})`]);
  });

  test("detector recognises dotted, bracket, destructured and literal forms", () => {
    const found = findEnvNames(
      "x.ts",
      `const a = process.env.DOT; const b = env["BRACKET"]; const { DESTRUCTURED, "QUOTED": q } = process.env;
       const c = deps.env.NESTED; const g = ENV.REGISTRY; const { ALSO_REGISTRY } = ENV; rangeEnv.trim(); const d = "AUTOMOBILE_LITERAL"; const e = "NOT_A_PRODUCT_LITERAL"; const f = other.PLAIN;`,
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
    const names = [...ENV_REGISTRY, ...AMBIENT_ENV_REGISTRY].flatMap((spec) =>
      spec.legacyName ? [spec.name, spec.legacyName] : [spec.name],
    );
    expect(new Set(names).size).toBe(names.length);
    const docs = readGuardFile(DOCS);
    const documented = [...ENV_REGISTRY, ...AMBIENT_ENV_REGISTRY]
      .filter((spec) => !spec.internal)
      .flatMap((spec) => (spec.legacyName ? [spec.name, spec.legacyName] : [spec.name]));
    const missing = documented.filter((name) => !docs.includes(`\`${name}\``));
    expect(missing, `Add to ${path.relative(ROOT, DOCS)}`).toEqual([]);
    for (const spec of [...ENV_REGISTRY, ...AMBIENT_ENV_REGISTRY]) {
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
