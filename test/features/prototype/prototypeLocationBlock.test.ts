import { describe, expect, test } from "bun:test";
import { prototypeSpecJsonSchema } from "../../../src/features/prototype/prototypeSpecJsonSchema";
import { prototypeLocationBlockError } from "../../../src/features/prototype/prototypeLocationBlock";
import { prototypeLocationBlockSchema } from "../../../src/features/prototype/prototypeLocationBlockSchema";

// The full spec contract served as automobile:prototype/spec-schema (#17710); built once here.
const specSchema = prototypeSpecJsonSchema() as { properties?: Record<string, unknown> };

const spec = (overrides: Record<string, unknown> = {}) => ({
  requires: { platform: ["location"], permissions: [{ name: "location", purpose: "Nearby" }] },
  location: { accuracy: "approximate", minIntervalMs: 5000, minDistanceM: 25 },
  ...overrides,
});

describe("prototypeLocationBlockError", () => {
  test("accepts a declared block and ignores a spec without one", () => {
    expect(prototypeLocationBlockError(spec())).toBeUndefined();
    expect(prototypeLocationBlockError({ requires: { platform: ["location"] } })).toBeUndefined();
  });

  test("refuses a block whose module is not in requires.platform", () => {
    const requires = { platform: ["battery"], permissions: [{ name: "location", purpose: "x" }] };
    expect(prototypeLocationBlockError(spec({ requires }))).toEqual({
      path: "location",
      message: "The location block requires location in requires.platform",
    });
    expect(prototypeLocationBlockError(spec({ requires: undefined }))?.path).toBe("location");
  });

  test("refuses a block without the location permission", () => {
    expect(prototypeLocationBlockError(spec({ requires: { platform: ["location"] } }))).toEqual({
      path: "location",
      message: "The location block requires permission location in requires.permissions",
    });
    const camera = { platform: ["location"], permissions: [{ name: "camera", purpose: "x" }] };
    expect(prototypeLocationBlockError(spec({ requires: camera }))?.path).toBe("location");
  });
});

describe("prototypeLocationBlockSchema", () => {
  test("bounds the interval and distance and refuses unknown fields", () => {
    const schema = prototypeLocationBlockSchema();
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ minIntervalMs: 1000, minDistanceM: 0 }).success).toBe(true);
    expect(schema.safeParse({ minIntervalMs: 999 }).success).toBe(false);
    expect(schema.safeParse({ minIntervalMs: 1500.5 }).success).toBe(false);
    expect(schema.safeParse({ minDistanceM: -1 }).success).toBe(false);
    expect(schema.safeParse({ accuracy: "coarse" }).success).toBe(false);
    expect(schema.safeParse({ background: true }).success).toBe(false);
  });

  test("the prototype spec schema inlines the block with no dangling $ref", () => {
    const advertised = specSchema.properties?.location;
    expect(JSON.stringify(advertised)).not.toContain("$ref");
    expect(advertised).toMatchObject({
      additionalProperties: false,
      properties: { minIntervalMs: { minimum: 1000 }, minDistanceM: { minimum: 0 } },
    });
  });
});
