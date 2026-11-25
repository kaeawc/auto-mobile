import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  knownPrototypeCapabilities,
  requiredPrototypeCapabilities,
} from "../../../../../src/features/prototype/prototypeCapabilityGates";
import {
  PROTOTYPE_WEB_UNADVERTISED_DERIVED_CAPABILITIES,
  prototypeWebBareSpecRequires,
} from "../../../../../src/features/prototype/web/embed/prototypeWebBareSpec";
import { PROTOTYPE_WEB_CAPABILITIES } from "../../../../../src/features/prototype/web/embed/prototypeWebCapabilities.generated";
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

  test("refuses a bare spec declaring a capability it lacks, asking for an update", () => {
    const error = refusal({
      ...spec,
      requires: { capabilities: ["prototype_from_the_future_v1"] },
    });
    expect(error).toMatchObject({
      code: "missingCapabilities",
      missing: ["prototype_from_the_future_v1"],
    });
    expect(error.message).toContain("cannot draw this spec");
    expect(error.message).toContain("Update the library.");
  });

  test("refuses a bare spec with a remote image, naming what to change", () => {
    const error = refusal({ ...spec, root: { type: "image", url: "https://example.com/a.png" } });
    expect(error).toMatchObject({
      code: "missingCapabilities",
      missing: ["prototype_remote_image_v1"],
    });
    expect(error.message).toContain("with bundled assets");
    expect(error.message).not.toContain("Update the library.");
  });

  test("refuses a bare spec over the base runtime budget", () => {
    const data = { rows: Array.from({ length: 2001 }, (_, index) => index) };
    expect(refusal({ ...spec, data })).toMatchObject({
      code: "missingCapabilities",
      missing: ["prototype_large_budget_v1"],
    });
  });

  test("draws a bare spec whose declared requires it advertises", () => {
    const declared = { ...spec, requires: ["prototype_stack_v1"] };
    expect(readPrototypeWebInput(declared)).toEqual({ spec: declared });
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

  test("remote images remain known but their envelopes are refused by default", () => {
    expect(knownPrototypeCapabilities()).toContain("prototype_remote_image_v1");
    expect(refusal(envelope({ requires: ["prototype_remote_image_v1"] }))).toMatchObject({
      code: "missingCapabilities",
      missing: ["prototype_remote_image_v1"],
    });
  });

  test("the generator refuses an empty set", () => {
    expect(() => renderPrototypeWebCapabilities([])).toThrow("No prototype capabilities");
    expect(() => renderPrototypeWebCapabilities(["prototype_remote_image_v1"])).toThrow(
      "No prototype capabilities",
    );
    const mixed = renderPrototypeWebCapabilities([
      "prototype_remote_image_v1",
      "prototype_stack_v1",
    ]);
    expect(mixed).toContain('"prototype_stack_v1"');
    expect(mixed).not.toContain('"prototype_remote_image_v1"');
  });
});

describe("bare spec requires (#16453)", () => {
  const advertised = new Set(PROTOTYPE_WEB_CAPABILITIES);
  const unadvertised = (names: readonly string[]) => names.filter((name) => !advertised.has(name));

  test("derive only capabilities the library does not advertise", () => {
    const derivable = [...knownPrototypeCapabilities(), "prototype_large_budget_v1"];
    expect(unadvertised(derivable).sort()).toEqual(
      [...PROTOTYPE_WEB_UNADVERTISED_DERIVED_CAPABILITIES].sort(),
    );
  });

  test.each([
    ["remote image", { root: { type: "image", url: "https://example.com/a.png" } }],
    [
      "bottom accessory image",
      { root: { type: "column", ios: { bottomAccessory: { type: "image", via: "device" } } } },
    ],
    ["oversized data", { data: { rows: Array.from({ length: 2001 }, () => 0) } }],
    ["declared requires", { requires: ["prototype_from_the_future_v1"] }],
  ])("refuse what the host's envelope would: %s", (_name, extra) => {
    const bare = { ...spec, ...extra };
    expect(unadvertised(prototypeWebBareSpecRequires(bare))).toEqual(
      unadvertised(requiredPrototypeCapabilities(bare)),
    );
    expect(unadvertised(prototypeWebBareSpecRequires(bare))).not.toEqual([]);
  });
});
