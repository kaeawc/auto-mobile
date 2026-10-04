import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OVERLAY_NODE_TYPES,
  OVERLAY_ACTION_TYPES,
  OVERLAY_PLACEMENT_TYPES,
  MAX_OVERLAY_SPEC_BYTES,
  MAX_OVERLAY_EMIT_PAYLOAD_BYTES,
  overlaySpecSchema,
} from "../../src/features/overlay/overlaySpec";
import { validateOverlaySpec } from "../../src/features/overlay/overlayValidation";

const fixtures = join(import.meta.dir, "../fixtures/overlay-spec");
function files(kind: string): string[] {
  return readdirSync(join(fixtures, kind))
    .filter((name) => name.endsWith(".json"))
    .sort();
}
const valid = files("valid").map((name) => ({
  name,
  json: readFileSync(join(fixtures, "valid", name), "utf8"),
}));
const invalid = files("invalid").map((name) => ({
  name,
  data: JSON.parse(readFileSync(join(fixtures, "invalid", name), "utf8")) as {
    spec: unknown;
    expectedPath: string;
  },
}));
function tags(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      tags(child, found);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "type" && typeof child === "string") {
      found.add(child);
    }
    tags(child, found);
  }
}

describe("shared overlay contract", () => {
  test("fixtures are nonempty and cover every node, action, and placement", () => {
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
    const found = new Set<string>();
    for (const fixture of valid) {
      tags(JSON.parse(fixture.json), found);
    }
    for (const type of [
      ...OVERLAY_NODE_TYPES,
      ...OVERLAY_ACTION_TYPES,
      ...OVERLAY_PLACEMENT_TYPES,
    ]) {
      expect(found.has(type)).toBe(true);
    }
  });
  for (const { name, json } of valid) {
    test(`decode ${name}`, () => {
      const result = validateOverlaySpec(json);
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(JSON.stringify(result.error));
      }
      expect(overlaySpecSchema.safeParse(result.data).success).toBe(true);
    });
  }
  for (const { name, data } of invalid) {
    test(`reject ${name} at ${data.expectedPath}`, () => {
      const result = validateOverlaySpec(data.spec);
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error(`Accepted ${name}`);
      }
      expect(result.error.path).toBe(data.expectedPath);
    });
  }
  test("raw UTF-8 byte limit includes whitespace and accepts its exact boundary", () => {
    const json = valid[0].json;
    const padding = MAX_OVERLAY_SPEC_BYTES - Buffer.byteLength(json);
    expect(validateOverlaySpec(json + " ".repeat(padding)).success).toBe(true);
    expect(validateOverlaySpec(json + " ".repeat(padding + 1))).toEqual({
      success: false,
      error: { path: "$", message: "Spec byte limit exceeded" },
    });
  });
  test("emit payload byte limit accepts the exact compact JSON boundary", () => {
    const spec = {
      id: "a",
      window: { placement: { type: "fullscreen" } },
      root: {
        type: "spacer",
        onTap: [
          { type: "emit", name: "a", payload: "x".repeat(MAX_OVERLAY_EMIT_PAYLOAD_BYTES - 2) },
        ],
      },
    };
    expect(validateOverlaySpec(spec).success).toBe(true);
  });
  test("malformed JSON reports the envelope path", () => {
    const result = validateOverlaySpec("{");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.path).toBe("$");
    }
  });
  test("key insertion order does not change the first error", () => {
    const first = {
      id: "a",
      window: { placement: { type: "fullscreen" } },
      root: { type: "text", text: 3, zebra: true, aaa: true },
    };
    const second = {
      root: { aaa: true, zebra: true, text: 3, type: "text" },
      window: first.window,
      id: "a",
    };
    expect(validateOverlaySpec(first)).toEqual(validateOverlaySpec(second));
  });
});

test("omitted window opacity defaults to 100", () => {
  const result = validateOverlaySpec({
    id: "default",
    window: { placement: { type: "fullscreen" } },
    root: { type: "spacer" },
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.window.opacity).toBe(100);
  }
});
test("JSON keys are preserved in state and opaque emit payloads", () => {
  const input = valid.find((fixture) => fixture.name === "opaque-json-keys.json");
  expect(input).toBeDefined();
  if (!input) {
    throw new Error("Missing opaque key fixture");
  }
  const result = validateOverlaySpec(input.json);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(JSON.stringify(result.error));
  }
  const source = JSON.parse(input.json) as { state: unknown; root: { onTap: unknown } };
  expect(result.data.state).toEqual(source.state);
  expect(result.data.root.onTap).toEqual(source.root.onTap);
});
test("undefined object properties are rejected before JSON serialization can drop them", () => {
  const result = validateOverlaySpec({
    id: "a",
    window: { placement: { type: "fullscreen" } },
    root: { type: "spacer", id: undefined },
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.path).toBe("root.id");
  }
});
test("worked documentation examples match the shared fixture files", () => {
  const document = readFileSync(
    join(import.meta.dir, "../../docs/design-docs/plat/android/overlay-ux.md"),
    "utf8",
  );
  const examples = document
    .split("```json\n")
    .slice(1)
    .map((block) => JSON.parse(block.split("```")[0]) as { id?: string })
    .filter((example) => example.id !== undefined);
  expect(examples.length).toBe(3);
  for (let index = 0; index < examples.length; index++) {
    const fixture = valid.find((entry) => entry.name === `doc-example-${index + 1}.json`);
    expect(fixture).toBeDefined();
    if (!fixture) {
      throw new Error("Missing document fixture");
    }
    expect(JSON.parse(fixture.json)).toEqual(examples[index]);
  }
});
test("non JSON numeric tokens and literal string controls are rejected", () => {
  for (const input of ["NaN", "Infinity", "01", "+1", "1.", "1e", '"literal\nnewline"']) {
    const result = validateOverlaySpec(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.path).toBe("$");
    }
  }
});
