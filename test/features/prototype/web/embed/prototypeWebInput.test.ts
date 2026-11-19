import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { knownPrototypeCapabilities } from "../../../../../src/features/prototype/prototypeCapabilityGates";
import {
  PROTOTYPE_WEB_LIBRARY_VERSION,
  PrototypeWebRefusal,
  readPrototypeWebInput,
} from "../../../../../src/features/prototype/web/embed/prototypeWebInput";
import { prototypeEmbedEnvelope } from "../../../../../src/features/prototype/web/prototypeEmbedResource";
import {
  renderPrototypeWebCapabilities,
  webCapabilitiesOutputPath,
} from "../../../../../scripts/prototype/generate-prototype-web-capabilities";
import rootPackage from "../../../../../package.json";

const spec = { id: "hello", root: { type: "text", text: "Hello" } };
const envelope = (fields: Record<string, unknown>) => ({
  format: "automobile-prototype-embed",
  version: 1,
  requires: [],
  spec,
  ...fields,
});

function refusal(value: unknown, advertised?: ReadonlySet<string>) {
  try {
    readPrototypeWebInput(value, advertised);
  } catch (error) {
    if (error instanceof PrototypeWebRefusal) {
      return error.error;
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("readPrototypeWebInput (#16453)", () => {
  test("draws a bare spec as given", () => {
    expect(readPrototypeWebInput(spec)).toEqual({ spec });
  });

  test("unwraps an envelope whose requires the library advertises", () => {
    const glyphs = { "filled/home": '<path d="M0 0h24v24H0z"></path>' };
    expect(readPrototypeWebInput(envelope({ requires: ["a"], glyphs }), new Set(["a"]))).toEqual({
      spec,
      glyphs,
    });
  });

  test("reads the host's own envelope", () => {
    expect(readPrototypeWebInput(prototypeEmbedEnvelope(spec)).spec).toEqual(spec);
  });

  test("refuses an unknown envelope version with the library version", () => {
    expect(refusal(envelope({ version: 2 }))).toMatchObject({
      code: "unknownVersion",
      missing: [],
      libraryVersion: PROTOTYPE_WEB_LIBRARY_VERSION,
    });
  });

  test("refuses missing capabilities whole, sorted and once each", () => {
    const error = refusal(envelope({ requires: ["z_v1", "a", "b_v1", "z_v1"] }), new Set(["a"]));
    expect(error.code).toBe("missingCapabilities");
    expect(error.missing).toEqual(["b_v1", "z_v1"]);
    expect(error.message).toContain("b_v1, z_v1");
  });

  test("refuses a non-object spec and a malformed envelope", () => {
    expect(refusal("spec").code).toBe("invalidInput");
    expect(refusal(envelope({ requires: "a" })).code).toBe("invalidInput");
    expect(refusal(envelope({ spec: [] })).code).toBe("invalidInput");
    expect(refusal(envelope({ glyphs: { "filled/home": 1 } })).code).toBe("invalidInput");
  });

  test("the library version follows @kaeawc/auto-mobile", () => {
    expect(PROTOTYPE_WEB_LIBRARY_VERSION).toBe(rootPackage.version);
  });
});

describe("advertised capabilities (#16453)", () => {
  test("match the host's; regenerate with bun scripts/prototype/generate-prototype-web-capabilities.ts", () => {
    const current = readFileSync(webCapabilitiesOutputPath, "utf8").replace(/\r\n/g, "\n");
    expect(current).toBe(renderPrototypeWebCapabilities(knownPrototypeCapabilities()));
  });

  test("the generator refuses an empty set", () => {
    expect(() => renderPrototypeWebCapabilities([])).toThrow("No prototype capabilities");
  });
});
