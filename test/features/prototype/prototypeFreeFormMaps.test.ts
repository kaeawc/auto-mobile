import { expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";

// The Kotlin and Swift capability scanners scan only the values of fields with these names,
// because their keys are free-form (#14320): a header, query, route param or call arg named
// "type" must not read as a typed action. That holds only while the contract keeps every
// field with one of these names a record.
const FREE_FORM_MAPS = ["headers", "query", "params", "args"];

type Rule = { kind?: string; name?: string };
const definitions = contract.definitions as Record<string, Rule>;

function isRecord(rule: Rule): boolean {
  if (rule.kind === "record") {
    return true;
  }
  const target = rule.kind === "ref" && rule.name ? definitions[rule.name] : undefined;
  return target?.kind === "record";
}

function namedFields(value: unknown, at: string, found: Array<[string, Rule]>): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => namedFields(child, `${at}[${index}]`, found));
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const fields = (value as { fields?: unknown }).fields;
  if (fields !== null && typeof fields === "object" && !Array.isArray(fields)) {
    for (const [name, field] of Object.entries(fields)) {
      if (FREE_FORM_MAPS.includes(name)) {
        found.push([`${at}.${name}`, (field as { rule: Rule }).rule]);
      }
    }
  }
  for (const [key, child] of Object.entries(value)) {
    namedFields(child, `${at}.${key}`, found);
  }
}

test("every headers, query, params and args field in the contract is a record", () => {
  const found: Array<[string, Rule]> = [];
  namedFields(contract.definitions, "definitions", found);
  expect(found.length).toBeGreaterThanOrEqual(7);
  expect(found.filter(([, rule]) => !isRecord(rule)).map(([path]) => path)).toEqual([]);
});
