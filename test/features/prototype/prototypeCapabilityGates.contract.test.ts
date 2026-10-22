import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PROTOTYPE_NETWORK_CAPABILITY,
  PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
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
const knownCapabilities = new Set(PROTOTYPE_SPEC_CAPABILITY_GATES.map((gate) => gate.capability));
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
  ].sort();
  expect(fixture).toEqual(expected);
});
