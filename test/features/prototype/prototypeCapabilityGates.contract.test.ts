import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOTYPE_ZOOM_TRANSITION_CAPABILITY,
  PROTOTYPE_ANCHOR_CAPABILITY,
  PROTOTYPE_NETWORK_CAPABILITY,
  PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
  PROTOTYPE_WINDOW_CHROME_CAPABILITY,
  PROTOTYPE_DEAD_TAP_CAPABILITY,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import {
  PROTOTYPE_SPEC_CAPABILITY_GATES,
  requiredPrototypeCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";

const fixtures = join(import.meta.dir, "../../fixtures");
const validFixtureDirectory = join(fixtures, "prototype-spec/valid");
// List once and sample every fourth sorted fixture: the full corpus's node-limit case
// exceeds the 100 ms unit budget. Keep sampled fixtures in separate tests as well.
const validFixtureFiles = readdirSync(validFixtureDirectory).sort();
const sampledValidFixtureFiles = validFixtureFiles.filter((_, index) => index % 4 === 0);
const knownCapabilities = new Set([
  ...PROTOTYPE_SPEC_CAPABILITY_GATES.map((gate) => gate.capability),
  PROTOTYPE_ANCHOR_CAPABILITY,
  PROTOTYPE_WINDOW_CHROME_CAPABILITY,
  PROTOTYPE_DEAD_TAP_CAPABILITY,
]);
const deviceRequestSpec = {
  root: {
    type: "button",
    label: "Load",
    onTap: [{ type: "request", via: "device", url: "https://example.com/feed" }],
  },
};

test("capability names are empty for plain and non-spec inputs", () => {
  for (const spec of [undefined, null, 3, {}, { root: { type: "text", text: "Hello" } }]) {
    expect(requiredPrototypeCapabilities(spec)).toEqual([]);
  }
});

test("device requests require the capabilities detected by the existing gates", () => {
  const expected = PROTOTYPE_SPEC_CAPABILITY_GATES.filter(
    (gate) => gate.fields(deviceRequestSpec).length > 0,
  ).map((gate) => gate.capability);
  expect(expected).toContain(PROTOTYPE_NETWORK_CAPABILITY);
  expect(expected).toContain(PROTOTYPE_NETWORK_DEVICE_CAPABILITY);
  expect(requiredPrototypeCapabilities(deviceRequestSpec)).toEqual([...new Set(expected)].sort());
});

test("capability names are sorted and unique across repeated feature uses", () => {
  const spec = {
    data: { title: "Feed" },
    root: {
      type: "column",
      children: [deviceRequestSpec.root, deviceRequestSpec.root],
    },
  };
  const capabilities = requiredPrototypeCapabilities(spec);
  expect(capabilities.length).toBeGreaterThan(1);
  expect(capabilities).toEqual([...capabilities].sort());
  expect(capabilities.length).toBe(new Set(capabilities).size);
});

test("anchors and an explicitly chromeless fullscreen window add their preflight capabilities (#14536)", () => {
  const anchored = {
    window: { placement: { type: "floating" } },
    root: {
      type: "column",
      children: [{ type: "text", text: "Tip", anchor: { type: "bounds", x: 0, y: 0 } }],
    },
  };
  expect(requiredPrototypeCapabilities(anchored)).toEqual([PROTOTYPE_ANCHOR_CAPABILITY]);

  const chromeless = (placement: string) => ({
    window: { placement: { type: placement }, chrome: "none" },
    root: { type: "text", text: "Hello" },
  });
  expect(requiredPrototypeCapabilities(chromeless("fullscreen"))).toEqual([
    PROTOTYPE_WINDOW_CHROME_CAPABILITY,
  ]);
  // Chrome on another placement is refused outright rather than gated, and a bar needs nothing.
  expect(requiredPrototypeCapabilities(chromeless("sheet"))).toEqual([]);
  expect(
    requiredPrototypeCapabilities({
      window: { placement: { type: "fullscreen" }, chrome: "bar" },
      root: { type: "text", text: "Hello" },
    }),
  ).toEqual([]);
});

test("valid spec fixtures are present", () => {
  expect(validFixtureFiles.length).toBeGreaterThan(0);
});

test.each(sampledValidFixtureFiles)(
  "sampled valid spec fixture %s requires only registered gate capabilities",
  (file) => {
    const spec: unknown = JSON.parse(
      readFileSync(join(validFixtureDirectory, file), "utf8").replace(/^\uFEFF/, ""),
    );
    const capabilities = requiredPrototypeCapabilities(spec);
    expect(
      capabilities.filter((capability) => !knownCapabilities.has(capability)),
      file,
    ).toEqual([]);
  },
);

test("shared capability fixture matches the sorted gate capability set", () => {
  const fixture: unknown = JSON.parse(
    readFileSync(join(fixtures, "prototype-capabilities/spec-capabilities.json"), "utf8"),
  );
  const expected = [
    ...new Set(PROTOTYPE_SPEC_CAPABILITY_GATES.map((gate) => gate.capability)),
    PROTOTYPE_ZOOM_TRANSITION_CAPABILITY,
  ].sort();
  expect(fixture).toEqual(expected);
});
