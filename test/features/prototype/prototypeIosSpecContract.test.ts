import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderPrototypePlatformPermissionsData } from "../../../scripts/ios/generate-prototype-platform-permissions";
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

test("embedded Swift platform permission mapping equals the canonical generator output", () => {
  const compiledPermissions = readFileSync(
    new URL(
      "../../../ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypePlatformPermissionsData.swift",
      import.meta.url,
    ),
    "utf8",
  );
  expect(compiledPermissions).toBe(renderPrototypePlatformPermissionsData());
});
