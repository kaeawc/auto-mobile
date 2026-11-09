import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ValidateFunction } from "ajv";
import { initializeCliTools } from "../../src/cli/cliToolRegistration";
import { prototypeSchema } from "../../src/server/prototypeTools";
import { registerPrototypeResources } from "../../src/server/prototypeResources";
import {
  advertisedSpecSchema,
  fullAdvertisedSpecSchema,
  isPrototypeFullSchemaEnabled,
  PROTOTYPE_SPEC_SCHEMA_URI,
  prototypeSpecJsonSchema,
  terseAdvertisedSpecSchema,
} from "../../src/server/prototypeTools/specJsonSchema";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { compileAjv2020 } from "../helpers/jsonSchemaCompile";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

// Strict mode rejects unknown keywords, union `type` arrays, required names a branch does not
// define and the like: the shape strict MCP clients enforce on tools/list (#17710).
const STRICT = { strict: true } as const;
const VALID_SPEC_DIR = path.join(import.meta.dir, "../fixtures/prototype-spec/valid");
const validSpecs = fs
  .readdirSync(VALID_SPEC_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({
    name,
    // A fixture may start with a byte order mark, which the spec reader tolerates.
    spec: JSON.parse(
      fs.readFileSync(path.join(VALID_SPEC_DIR, name), "utf8").replace(/^\uFEFF/, ""),
    ) as unknown,
  }));

function references(value: unknown, found: string[] = []): string[] {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" || key === "$defs" || key === "definitions") {
        found.push(key);
      } else {
        references(child, found);
      }
    }
  }
  return found;
}

describe("prototype tools/list input schema contract", () => {
  let restore: () => void;
  let inputSchema: Record<string, unknown>;
  let strictValidate: ValidateFunction;
  beforeAll(() => {
    restore = preserveToolRegistry();
    ToolRegistry.clearTools();
    initializeCliTools();
    inputSchema = ToolRegistry.getToolDefinitions({ includeUnavailable: true }).find(
      (tool) => tool.name === "prototype",
    )!.inputSchema as Record<string, unknown>;
    // Compiling under strict mode is the contract; it throws on any strict-mode violation.
    strictValidate = compileAjv2020(inputSchema, STRICT);
    strictValidate({ action: "status" });
  });
  afterAll(() => restore());

  test("compiles under a strict JSON Schema validator and uses no $ref or $defs", () => {
    expect(typeof strictValidate).toBe("function");
    expect(references(inputSchema)).toEqual([]);
    expect(JSON.stringify(inputSchema.properties)).toContain(PROTOTYPE_SPEC_SCHEMA_URI);
  });

  test("the terse spec accepts every valid spec fixture", () => {
    expect(validSpecs.length).toBeGreaterThan(0);
    const rejected = validSpecs
      .filter(({ spec }) => !strictValidate({ action: "show", spec }))
      .map(({ name }) => name);
    expect(rejected).toEqual([]);
  });

  test("server-side validation still rejects what the terse schema lets through", () => {
    const spec = { id: "p", window: { placement: { type: "fullscreen" } }, root: { type: "nope" } };
    expect(strictValidate({ action: "show", spec })).toBe(true);
    const parsed = prototypeSchema.safeParse({ action: "show", spec });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("Invalid prototype at spec.root");
  });
});

describe("prototype spec schema forms", () => {
  test("the terse form keeps every top-level spec field and its required list", () => {
    const document = prototypeSpecJsonSchema();
    const terse = terseAdvertisedSpecSchema();
    expect(Object.keys(terse.properties as object)).toEqual(
      Object.keys(document.properties as object),
    );
    expect(terse.required).toEqual(document.required);
    expect(terse.additionalProperties).toBe(false);
    expect(references(terse)).toEqual([]);
  });

  test("the flag selects the full schema, rooted under the spec property", () => {
    expect(isPrototypeFullSchemaEnabled({})).toBe(false);
    expect(isPrototypeFullSchemaEnabled({ AUTOMOBILE_PROTOTYPE_FULL_SCHEMA: "1" })).toBe(true);
    expect(advertisedSpecSchema(false)).toEqual(terseAdvertisedSpecSchema());
    const full = advertisedSpecSchema(true);
    expect(full).toEqual(fullAdvertisedSpecSchema());
    expect(full.$schema).toBeUndefined();
    const components = JSON.stringify((full.properties as Record<string, unknown>).components);
    expect(components).toContain('"$ref":"#/properties/spec/properties/root"');
  });
});

describe(`${PROTOTYPE_SPEC_SCHEMA_URI} resource`, () => {
  beforeAll(() => registerPrototypeResources());

  test("is listed and serves the full spec JSON Schema", async () => {
    const listed = ResourceRegistry.getResourceDefinitions().find(
      (resource) => resource.uri === PROTOTYPE_SPEC_SCHEMA_URI,
    );
    expect(listed?.mimeType).toBe("application/schema+json");
    const content = await ResourceRegistry.getResource(PROTOTYPE_SPEC_SCHEMA_URI)!.handler();
    expect(content.mimeType).toBe("application/schema+json");
    expect(JSON.parse(content.text ?? "")).toEqual(prototypeSpecJsonSchema());
  });
});
