import { z } from "zod/v4";

/** The JSON Schema keywords the schema-shape tests assert on. */
export interface JsonSchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  enum?: unknown[];
  description?: string;
  minimum?: number;
  minProperties?: number;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  if?: JsonSchemaNode;
  then?: JsonSchemaNode;
}

/** A sub-schema may be the boolean form (`true`/`false`); it carries no keywords here. */
const child = (): z.ZodType<JsonSchemaNode, unknown> =>
  z.union([z.lazy(() => jsonSchemaNodeSchema), z.boolean().transform((): JsonSchemaNode => ({}))]);

const jsonSchemaNodeSchema: z.ZodType<JsonSchemaNode, unknown> = z.lazy(() =>
  z.looseObject({
    type: z.string().optional(),
    required: z.array(z.string()).optional(),
    properties: z.record(z.string(), child()).optional(),
    enum: z.array(z.unknown()).optional(),
    description: z.string().optional(),
    minimum: z.number().optional(),
    minProperties: z.number().optional(),
    anyOf: z.array(child()).optional(),
    oneOf: z.array(child()).optional(),
    allOf: z.array(child()).optional(),
    if: child().optional(),
    then: child().optional(),
  }),
);

/** Validate an untyped advertised schema into a typed node (throws on a malformed schema). */
export function parseJsonSchemaNode(value: unknown): JsonSchemaNode {
  return jsonSchemaNodeSchema.parse(value);
}
