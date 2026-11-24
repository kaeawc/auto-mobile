import { expect, test } from "bun:test";
import vectors from "../../fixtures/prototype-spec/links/resolver-vectors.json";
import { resolvePrototypeLink } from "../../../src/features/prototype/prototypeLinkResolver";
for (const vector of vectors.cases) {
  test(`registered inbound URL: ${vector.url}`, () => {
    expect(resolvePrototypeLink(vector.url, vector.registration, vectors.table) ?? null).toEqual<
      typeof vector.expected
    >(vector.expected);
  });
}
