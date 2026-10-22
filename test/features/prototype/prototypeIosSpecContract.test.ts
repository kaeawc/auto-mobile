import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderPrototypeSpecContractData } from "../../../scripts/ios/generate-prototype-spec-contract";

const compiled = readFileSync(
  new URL(
    "../../../ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeSpecContractData.swift",
    import.meta.url,
  ),
  "utf8",
);

test("embedded Swift structural contract equals the canonical generator output", () => {
  expect(compiled).toBe(renderPrototypeSpecContractData());
});
