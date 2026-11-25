import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  renderContractOutputPath,
  renderPrototypeRenderContract,
} from "../../../scripts/prototype/generate-prototype-render-contract";

describe("generated prototype render contract (#16451)", () => {
  test("matches the contract; regenerate with bun scripts/prototype/generate-prototype-render-contract.ts", () => {
    const current = readFileSync(
      new URL(`../../../${renderContractOutputPath}`, import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n"); // Windows checkouts may convert the file to CRLF
    expect(current).toBe(renderPrototypeRenderContract(contract));
  });

  test("refuses a contract without a limit the renderer reads", () => {
    const limits = Object.fromEntries(
      Object.entries(contract.limits).filter(([name]) => name !== "MAX_PROTOTYPE_NODES"),
    );
    expect(() => renderPrototypeRenderContract({ ...contract, limits })).toThrow(
      "Contract limit MAX_PROTOTYPE_NODES: not found",
    );
  });

  test("refuses a contract whose repeat items have no array maximum", () => {
    const definitions = structuredClone(contract.definitions);
    definitions.repeat.fields.items.rule.options =
      definitions.repeat.fields.items.rule.options.filter((option) => option.kind !== "array");
    expect(() => renderPrototypeRenderContract({ ...contract, definitions })).toThrow(
      "Contract repeat.items: no array option with a max",
    );
  });

  test("refuses a contract without the large runtime budget (#16453)", () => {
    expect(() => renderPrototypeRenderContract({ ...contract, runtimeBudgets: {} })).toThrow(
      "Contract runtimeBudgets.prototype_large_budget_v1: no limits",
    );
  });

  test("names each raised limit at its base contract value (#16453)", () => {
    const rendered = renderPrototypeRenderContract(contract);
    for (const [name, value] of Object.entries(contract.runtimeBudgets.prototype_large_budget_v1)) {
      expect(rendered).toContain(`  ${name}: ${value},`);
      expect(rendered).toContain(
        `  ${name}: ${contract.limits[name as keyof typeof contract.limits]},`,
      );
    }
  });
});
