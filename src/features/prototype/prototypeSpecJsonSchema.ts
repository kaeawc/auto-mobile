import { z as specZ, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ENV, readEnvBool } from "../../config/env";
import { enforceAnthropicToolSchemaSubset } from "../../utils/schemaHelpers";
import { MAX_PROTOTYPE_COMPONENT_DEPTH } from "./prototypeComponents";
import { prototypeSpecSchema } from "./prototypeSpec";
import { PROTOTYPE_SPEC_SCHEMA_URI } from "./prototypeGuide";
import { STATE_KEY } from "./prototypeTemplate";

export { PROTOTYPE_SPEC_SCHEMA_URI };

type JsonObject = Record<string, unknown>;

/**
 * Whether `tools/list` inlines the full spec JSON Schema in the prototype tool's `spec` field
 * instead of the terse form that points at {@link PROTOTYPE_SPEC_SCHEMA_URI}.
 */
export function isPrototypeFullSchemaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvBool(ENV.PROTOTYPE_FULL_SCHEMA, env);
}

// The settled spec is Zod 3; registry/device targeting use Zod 4. It is converted with
// the same `zod-to-json-schema` options the v1 MCP SDK's `toJsonSchemaCompat` applied to a
// Zod 3 schema, so the advertised schema is unchanged by the SDK v2 migration (#4678) and
// no second spec schema is authored.
const convertSpec = (schema: ZodTypeAny): JsonObject =>
  zodToJsonSchema(schema, { strictUnions: true, pipeStrategy: "input" });

/**
 * The contract and validator reject `theme: {}` and `theme.colors: {}`, but a Zod refinement has no
 * JSON Schema form, so state it on the advertised schema for schema-driven clients.
 */
function requireNonEmptyThemeObjects(spec: JsonObject): void {
  const theme = (spec.properties as Record<string, JsonObject> | undefined)?.theme;
  if (!theme) {
    return;
  }
  theme.minProperties = 1;
  const colors = (theme.properties as Record<string, JsonObject> | undefined)?.colors;
  if (colors) {
    colors.minProperties = 1;
  }
}

/**
 * Reusable components (#11053) are expanded on the host before validation, so they are not part of
 * the device spec schema; advertise the authored `components` map and `use` node here. Every
 * child slot already points at the root node schema, so a `use` fits wherever a node does.
 */
function advertiseComponents(spec: JsonObject): void {
  const properties = spec.properties as Record<string, JsonObject> | undefined;
  const root = properties?.root;
  if (!properties || !Array.isArray(root?.anyOf)) {
    return;
  }
  const name = { type: "string", pattern: STATE_KEY.source };
  root.anyOf = [
    ...(root.anyOf as unknown[]),
    {
      type: "object",
      description:
        "Replaced on the host by components[component].root with {props.<field>} bound in the fields repeat binds; a placeholder that is the whole value keeps the prop's type",
      properties: {
        type: { type: "string", enum: ["use"] },
        component: name,
        props: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
      },
      required: ["type", "component"],
      additionalProperties: false,
    },
  ];
  properties.components = {
    type: "object",
    description: `Reusable node templates by name, placed with {type:"use",component,props}; expanded on the host before validation (use nesting up to ${MAX_PROTOTYPE_COMPONENT_DEPTH} deep, no cycles, every prop used); limits apply to the expanded spec`,
    propertyNames: { pattern: STATE_KEY.source },
    additionalProperties: {
      type: "object",
      properties: { root: { $ref: "#/properties/root" } },
      required: ["root"],
      additionalProperties: false,
    },
  };
}

function buildSpecDocument(): JsonObject {
  // Give JSON Schema a canonical root before the recursive window/theme bottom-accessory slots.
  // Preserve the device parser's field order for serialized native resources.
  const { root, ...fields } = prototypeSpecSchema.shape;
  const document = convertSpec(specZ.object({ root, ...fields }).strict());
  requireNonEmptyThemeObjects(document);
  advertiseComponents(document);
  return document;
}

let specDocument: JsonObject | undefined;

/**
 * The full authored-spec JSON Schema as a standalone document: internal `$ref`s point at this
 * document's root. It is what {@link PROTOTYPE_SPEC_SCHEMA_URI} serves. Built once on first use.
 */
export function prototypeSpecJsonSchema(): JsonObject {
  specDocument ??= buildSpecDocument();
  return specDocument;
}

function rehomeReferences(value: unknown, prefix: string): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#")) {
      (value as JsonObject)[key] = `${prefix}${child.slice(1)}`;
    } else {
      rehomeReferences(child, prefix);
    }
  }
}

/** The full spec schema inlined at the tool input's `spec` property (the opt-in form). */
export function fullAdvertisedSpecSchema(): JsonObject {
  const inline = structuredClone(prototypeSpecJsonSchema());
  rehomeReferences(inline, "#/properties/spec");
  delete inline.$schema;
  return inline;
}

/**
 * A prototype tool input schema with the full spec schema inlined at `spec`, built from either
 * advertised form. The `spec` description and every other field are kept, and the result gets the
 * input-schema normalization the live registry applies (drops empty branches). Returns a copy.
 */
export function withFullAdvertisedSpecSchema(inputSchema: JsonObject): JsonObject {
  const inline = structuredClone(inputSchema);
  const properties = inline.properties as Record<string, JsonObject>;
  properties.spec = { description: properties.spec?.description, ...fullAdvertisedSpecSchema() };
  enforceAnthropicToolSchemaSubset(inline);
  return inline;
}

const TERSE_KEYWORDS = ["type", "enum", "const", "minLength"] as const;

function terseProperty(property: JsonObject): JsonObject {
  const terse: JsonObject = {};
  for (const keyword of TERSE_KEYWORDS) {
    if (Object.hasOwn(property, keyword)) {
      terse[keyword] = property[keyword];
    }
  }
  // An object-valued block converted as allOf/anyOf (e.g. channels) is still an object.
  if (terse.type === undefined && Object.keys(property).length > 0) {
    terse.type = "object";
  }
  return terse;
}

function nodeTypes(root: JsonObject | undefined): string[] {
  const arms = Array.isArray(root?.anyOf) ? (root.anyOf as JsonObject[]) : [];
  return [
    ...new Set(
      arms.flatMap((arm) => {
        const type = (arm.properties as Record<string, JsonObject> | undefined)?.type;
        return Array.isArray(type?.enum) ? (type.enum as string[]) : [];
      }),
    ),
  ];
}

/**
 * The default advertised `spec` schema: the spec's top-level fields with their JSON types only,
 * with no `$ref` or `$defs`. The full contract is in {@link PROTOTYPE_SPEC_SCHEMA_URI}; the
 * server validates every spec against it whichever form is advertised.
 */
export function terseAdvertisedSpecSchema(): JsonObject {
  const document = prototypeSpecJsonSchema();
  const properties = document.properties as Record<string, JsonObject>;
  const terse = Object.fromEntries(
    Object.entries(properties).map(([key, property]) => [key, terseProperty(property)]),
  );
  terse.root = {
    type: "object",
    description: `Root node {type,...}; type is one of ${nodeTypes(properties.root).join(", ")}. Every node's fields are in ${PROTOTYPE_SPEC_SCHEMA_URI}.`,
  };
  return {
    type: "object",
    properties: terse,
    required: document.required,
    additionalProperties: false,
  };
}

/** The `spec` schema `tools/list` advertises: terse by default, full when the flag is on. */
export function advertisedSpecSchema(full: boolean = isPrototypeFullSchemaEnabled()): JsonObject {
  return full ? fullAdvertisedSpecSchema() : terseAdvertisedSpecSchema();
}
