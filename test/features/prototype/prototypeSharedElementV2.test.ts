import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import corpus from "../../fixtures/prototype-spec/corpus.json";

const directory = new URL("../../fixtures/prototype-spec/", import.meta.url);
interface InvalidFixture {
  spec: unknown;
  expectedPath: string;
  expectedMessage: string;
  options?: { supportedCapabilities: string[] };
}
const fixtures = new Map<string, unknown>();
beforeAll(() => {
  for (const folder of ["valid", "invalid"] as const) {
    for (const name of corpus[folder].filter(
      (name) => name.includes("shared-v2") || name.includes("shared_element_v2"),
    )) {
      fixtures.set(
        `${folder}/${name}`,
        JSON.parse(readFileSync(new URL(`${folder}/${name}`, directory), "utf8")),
      );
    }
  }
});
for (const name of corpus.valid.filter((name) => name.startsWith("shared-v2"))) {
  test(`v2 accepts ${name} and gates new vocabulary`, () => {
    const spec = fixtures.get(`valid/${name}`)!;
    const capabilities = prototypeGateCapabilities(spec);
    expect(capabilities).toContain("prototype_shared_element_v2");
    expect(capabilities.includes("prototype_shared_element_v1")).toBe(
      name === "shared-v2-alias.json",
    );
    expect(validatePrototypeSpec(spec)).toMatchObject({ success: true });
    expect(
      validatePrototypeSpec(spec, {
        supportedCapabilities: capabilities,
        requiredCapabilities: prototypeGateCapabilities,
      }),
    ).toMatchObject({ success: true });
  });
}
for (const name of corpus.invalid.filter(
  (name) => name.startsWith("shared-v2") || name.includes("shared_element_v2"),
)) {
  test(`v2 rejects ${name} at the contract path`, () => {
    const fixture = fixtures.get(`invalid/${name}`) as InvalidFixture;
    expect(
      validatePrototypeSpec(fixture.spec, {
        ...fixture.options,
        requiredCapabilities: prototypeGateCapabilities,
      }),
    ).toMatchObject({
      success: false,
      error: { path: fixture.expectedPath, message: fixture.expectedMessage },
    });
  });
}
