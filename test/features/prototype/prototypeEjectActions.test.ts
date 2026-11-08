import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { untranslatedActionLists } from "../../../src/features/prototype/prototypeEjectActions";
import { record } from "../../../src/features/prototype/prototypeTemplate";

/**
 * Contract-driven coverage for the eject's action inventory (#16504, #17156): every action list
 * reachable from a node variant through its own (non-node, non-action) fields must be reported,
 * so a new nested action field in the contract cannot silently escape `remaining`.
 */

const DEFINITIONS: Record<string, unknown> = contract.definitions;
const ACTION = { type: "emit", name: "e" };

/** A value that holds exactly one action list, and that list's path suffix inside the value. */
interface Sample {
  readonly value: unknown;
  readonly suffix: string;
}

type Builder = (rule: Record<string, unknown>, seen: ReadonlySet<string>) => Sample[];

const BUILDERS: Readonly<Record<string, Builder>> = {
  ref: (rule, seen) => {
    const name = String(rule.name);
    return name === "node" || name === "action" || seen.has(name)
      ? []
      : samples(DEFINITIONS[name], new Set([...seen, name]));
  },
  array: (rule, seen) =>
    record(rule.item)?.kind === "ref" && record(rule.item)?.name === "action"
      ? [{ value: [ACTION], suffix: "" }]
      : samples(rule.item, seen).map((s) => ({ value: [s.value], suffix: `[0]${s.suffix}` })),
  map: (rule, seen) =>
    samples(rule.item, seen).map((s) => ({ value: { k: s.value }, suffix: `["k"]${s.suffix}` })),
  object: (rule, seen) =>
    Object.entries(record(rule.fields) ?? {}).flatMap(([name, field]) =>
      samples(record(field)?.rule, seen).map((s) => ({
        value: { [name]: s.value },
        suffix: `.${name}${s.suffix}`,
      })),
    ),
  tagged: (rule, seen) =>
    Object.entries(record(rule.variants) ?? {}).flatMap(([type, variant]) =>
      samples(variant, seen).map((s) => ({
        value: { ...record(s.value), type },
        suffix: s.suffix,
      })),
    ),
  choice: (rule, seen) =>
    Array.isArray(rule.options) ? rule.options.flatMap((option) => samples(option, seen)) : [],
};

function samples(rule: unknown, seen: ReadonlySet<string>): Sample[] {
  const r = record(rule);
  const kind = typeof r?.kind === "string" ? r.kind : "";
  return r && Object.hasOwn(BUILDERS, kind) ? BUILDERS[kind](r, seen) : [];
}

const VARIANTS = Object.entries(record(record(DEFINITIONS.node)?.variants) ?? {});

describe("eject action inventory", () => {
  test("every action-bearing path of every node variant is reported, except its own onTap", () => {
    const missed: string[] = [];
    let checked = 0;
    for (const [type, variant] of VARIANTS) {
      for (const sample of samples(variant, new Set())) {
        const node = { ...record(sample.value), type };
        const paths = untranslatedActionLists(node, "root").map((list) => list.path);
        const expected = `root${sample.suffix}`;
        if (sample.suffix === ".onTap") {
          expect(paths).not.toContain(expected);
        } else if (!paths.includes(expected)) {
          missed.push(`${type}: ${expected}`);
        }
        checked += 1;
      }
    }
    expect(missed).toEqual([]);
    // Guard against a vacuous walk: nested lists like text spans must be among the cases.
    expect(checked).toBeGreaterThan(VARIANTS.length);
    expect(VARIANTS.length).toBeGreaterThan(0);
  });

  test("finds the nested text span list the issue reported", () => {
    const node = { type: "text", spans: [{ text: "a" }, { text: "b", onTap: [ACTION] }] };
    expect(untranslatedActionLists(node, "root").map((list) => list.path)).toEqual([
      "root.spans[1].onTap",
    ]);
  });
});
