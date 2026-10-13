import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import table from "../../../schemas/prototype-ios-icon-symbols.json";
import contract from "../../../schemas/prototype-spec-contract.json";
import { renderPrototypeIconSymbolData } from "../../../scripts/ios/generate-prototype-icon-symbols";
import { IOS_PROTOTYPE_MAPPED_ICON_NAMES } from "../../../src/features/prototype/prototypePlatformNotes";

const compiled = readFileSync(
  new URL(
    "../../../ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeIconSymbolData.swift",
    import.meta.url,
  ),
  "utf8",
);
const names = contract.definitions.iconName.values;
const mapped = Object.keys(table.mapped);
const mappedSet = new Set(mapped);
const unmappedSet = new Set(table.unmapped);

describe("canonical iOS icon symbols", () => {
  test("compiled Swift equals the generator output", () => {
    expect(compiled).toBe(renderPrototypeIconSymbolData(table));
  });
  test("mapped and unmapped partition the contract in contract order", () => {
    expect(mapped).toEqual(names.filter((name) => mappedSet.has(name)));
    expect(table.unmapped).toEqual(names.filter((name) => unmappedSet.has(name)));
    expect(mapped.filter((name) => unmappedSet.has(name))).toEqual([]);
    expect(new Set([...mapped, ...table.unmapped])).toEqual(new Set(names));
    expect(mapped.length + table.unmapped.length).toBe(names.length);
  });
  test("all mapped entries have a default symbol and preserve legacy coverage", () => {
    expect(Object.values(table.mapped).every((entry) => entry.symbol.length > 0)).toBe(true);
    expect([...IOS_PROTOTYPE_MAPPED_ICON_NAMES].filter((name) => !mappedSet.has(name))).toEqual([]);
  });
});
