import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import contract from "../../../schemas/prototype-spec-contract.json";
import corpus from "../../fixtures/prototype-spec/corpus.json";

/**
 * Coverage gate (#15118): every node type, action type, node field, style field and theme field in
 * the structural contract must appear in at least one valid corpus fixture. The fixtures are decoded
 * by the Swift, Kotlin and TS corpus tests, so one gate keeps all three decoders exercised. An
 * uncovered item needs a fixture, or an entry in an EXEMPT list with the reason it cannot have one.
 */

type Json = unknown;
type Obj = Record<string, Json>;
const isObj = (value: Json): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const defs: Obj = contract.definitions;

/** The keys of `definitions[name][key]` (an object's `fields`, or a tagged union's `variants`). */
function keysOf(name: string, key: "fields" | "variants", variant?: string): string[] {
  const definition = defs[name];
  let node = isObj(definition) ? definition[key] : undefined;
  if (variant !== undefined) {
    node = isObj(node) ? node[variant] : undefined;
    node = isObj(node) ? node.fields : undefined;
  }
  return isObj(node) ? Object.keys(node) : [];
}

const NODE_TYPES = keysOf("node", "variants");
const ACTION_TYPES = keysOf("action", "variants");
const STYLE_FIELDS = keysOf("style", "fields");
const THEME_FIELDS = [
  ...keysOf("theme", "fields").map((field) => `theme.${field}`),
  ...["themeColors", "themeTypography", "themeShapes"].flatMap((name) =>
    keysOf(name, "fields").map((field) => `${name}.${field}`),
  ),
];
// A field is covered when some valid fixture sets it on a node it belongs to. Fields shared by every
// node type (id, style, onTap, ...) are tracked by name, not once per type.
const NODE_FIELDS = [...new Set(NODE_TYPES.flatMap((type) => keysOf("node", "variants", type)))];

/** Items with no valid fixture yet, each with the reason. Shrink this list; never grow it quietly. */
const EXEMPT: Record<string, Record<string, string>> = {
  nodeTypes: {},
  actionTypes: {},
  nodeFields: {},
  styleFields: {},
  themeFields: {},
};

interface Seen {
  nodeTypes: Set<string>;
  actionTypes: Set<string>;
  nodeFields: Set<string>;
  styleFields: Set<string>;
  themeFields: Set<string>;
}

function collect(value: Json, parentKey: string | undefined, seen: Seen): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, parentKey, seen);
    }
    return;
  }
  if (!isObj(value)) {
    return;
  }
  const type = value.type;
  if (typeof type === "string") {
    if (NODE_TYPES.includes(type)) {
      seen.nodeTypes.add(type);
      for (const field of Object.keys(value)) {
        seen.nodeFields.add(field);
      }
    }
    if (ACTION_TYPES.includes(type)) {
      seen.actionTypes.add(type);
    }
  }
  if (parentKey === "style") {
    for (const field of Object.keys(value)) {
      seen.styleFields.add(field);
    }
  }
  if (parentKey === "theme") {
    for (const field of Object.keys(value)) {
      seen.themeFields.add(`theme.${field}`);
    }
  }
  if (parentKey === "colors" || parentKey === "typography" || parentKey === "shapes") {
    const name = { colors: "themeColors", typography: "themeTypography", shapes: "themeShapes" }[
      parentKey
    ];
    for (const field of Object.keys(value)) {
      seen.themeFields.add(`${name}.${field}`);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    collect(child, key, seen);
  }
}

function coverage(): Seen {
  const seen: Seen = {
    nodeTypes: new Set(),
    actionTypes: new Set(),
    nodeFields: new Set(),
    styleFields: new Set(),
    themeFields: new Set(),
  };
  for (const file of corpus.valid) {
    const text = readFileSync(
      new URL(`../../fixtures/prototype-spec/valid/${file}`, import.meta.url),
      "utf8",
    );
    collect(JSON.parse(text.replace(/^\uFEFF/, "")), undefined, seen);
  }
  return seen;
}

const seen = coverage();

function missing(all: string[], covered: Set<string>, exempt: Record<string, string>): string[] {
  return all.filter((item) => !covered.has(item) && !(item in exempt));
}

describe("prototype corpus covers the structural contract (#15118)", () => {
  const cases: Array<[string, string[], Set<string>]> = [
    ["nodeTypes", NODE_TYPES, seen.nodeTypes],
    ["actionTypes", ACTION_TYPES, seen.actionTypes],
    ["nodeFields", NODE_FIELDS, seen.nodeFields],
    ["styleFields", STYLE_FIELDS, seen.styleFields],
    ["themeFields", THEME_FIELDS, seen.themeFields],
  ];
  for (const [name, all, covered] of cases) {
    test(`every ${name} item has a valid fixture or a reasoned exemption`, () => {
      expect(missing(all, covered, EXEMPT[name])).toEqual([]);
    });
    test(`${name} exemptions name items that exist and are still uncovered`, () => {
      const stale = Object.keys(EXEMPT[name]).filter(
        (item) => !all.includes(item) || covered.has(item),
      );
      expect(stale).toEqual([]);
    });
  }
});
