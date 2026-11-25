import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { requiredPrototypeCapabilities } from "../../../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeWebBareSpecRequires } from "../../../../../src/features/prototype/web/embed/prototypeWebBareSpec";
import { PROTOTYPE_WEB_CAPABILITIES } from "../../../../../src/features/prototype/web/embed/prototypeWebCapabilities.generated";

// The whole valid corpus takes over a second through the host's gate table, past the unit budget.
const corpusDir = "test/fixtures/prototype-spec/valid";
const corpus = readdirSync(corpusDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({
    name,
    // Some fixtures keep a byte order mark on purpose; the parsed spec is what both sides read.
    spec: JSON.parse(readFileSync(`${corpusDir}/${name}`, "utf8").replace(/^\uFEFF/, "")),
  }));

describe("bare spec requires across the corpus (#16453)", () => {
  const advertised = new Set(PROTOTYPE_WEB_CAPABILITIES);
  const unadvertised = (names: readonly string[]) => names.filter((name) => !advertised.has(name));

  test("refuse what the host's envelope would, across the valid spec corpus", () => {
    expect(corpus.length).toBeGreaterThan(100);
    const disagreements = corpus.filter(
      ({ spec: entry }) =>
        JSON.stringify(unadvertised(prototypeWebBareSpecRequires(entry))) !==
        JSON.stringify(unadvertised(requiredPrototypeCapabilities(entry))),
    );
    expect(disagreements.map(({ name }) => name)).toEqual([]);
  });
});
