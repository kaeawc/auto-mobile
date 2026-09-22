import { z } from "zod/v4";

/** Shared platform schema — single source of truth for all tool schemas. */
export const platformSchema = z.enum(["android", "ios"]);

export const DEVICE_LABEL_DESCRIPTION = "Device label";

/**
 * Response-shape control for tools that embed a post-action observation (issue
 * #5872). Spread into an action tool's `z.object` shape to give it the same
 * projection control `observe` already has: the embedded observation defaults to
 * the compact skeleton, and these two fields opt back into the raw hierarchy.
 * The compact form always lands under `skeleton`, the raw form under
 * `viewHierarchy`, regardless of which tool produced it.
 */
export const responseShapeControlFields = {
  raw: z
    .boolean()
    .optional()
    .describe("Return the raw view hierarchy instead of the compact skeleton"),
  project: z
    .enum(["full", "skeleton"])
    .optional()
    .describe(
      "Observation projection. 'skeleton' (default) returns a flat, actionable-only list " +
        "(elementId/label/bounds/affordances) under `skeleton` in place of `viewHierarchy`; 'full' " +
        "returns the raw view hierarchy under `viewHierarchy`. Each skeleton elementId/label is " +
        "directly usable as a tapOn selector, except the collapsed keyboard row `<ime>` " +
        "(drive it with sendKeys); re-request with raw/project:'full' to disambiguate.",
    ),
} as const;

export const appIdFieldAliases = [
  "packageId",
  "package",
  "packageName",
  "appPackage",
  "appPackageId",
  "bundle",
  "bundleId",
  "bundleID",
  "bundleIdentifier",
  "application",
  "applicationId",
  "applicationIdentifier",
  "app",
  "appIdentifier",
  "package_id",
  "package_name",
  "bundle_id",
  "application_id",
] as const;

export const APP_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const APP_ID_MAX_LENGTH = 256;

export const appIdSchema = z
  .string()
  .trim()
  .refine(
    (appId) => appId.length > 0 && appId.length <= APP_ID_MAX_LENGTH && APP_ID_PATTERN.test(appId),
    {
      error: (issue) =>
        `appId must be a reverse-DNS identifier such as com.example.app; got: ${issue.input}`,
    },
  );

export type FieldAliasMap = Record<string, readonly string[]>;

export type JsonSchemaOverride = (jsonSchema: Record<string, unknown>) => void;

const jsonSchemaOverrides = new WeakMap<object, JsonSchemaOverride>();
const postFlattenJsonSchemaOverrides = new WeakMap<object, JsonSchemaOverride>();
const injectedDeviceIdSchemas = new WeakSet<object>();

export function withJsonSchemaOverride<T extends z.ZodTypeAny>(
  schema: T,
  override: JsonSchemaOverride,
): T {
  jsonSchemaOverrides.set(schema, override);
  return schema;
}

/**
 * Register an override that runs on the ADVERTISED JSON Schema AFTER
 * {@link flattenTopLevelUnion} has collapsed a top-level `z.union(...)` into a
 * single object schema. A per-node {@link withJsonSchemaOverride} only sees the
 * pre-flatten arm, and flattening reduces that arm's `required` to the cross-arm
 * intersection (or re-homes it under a branch discriminator), so a wire contract
 * that must hold on ONE arm of a flattened union has to be re-asserted here,
 * against the post-flatten shape. Keyed by the top-level (union) schema identity
 * the tool registers as its output/input schema.
 */
export function withPostFlattenJsonSchemaOverride<T extends z.ZodTypeAny>(
  schema: T,
  override: JsonSchemaOverride,
): T {
  postFlattenJsonSchemaOverrides.set(schema, override);
  return schema;
}

export function withCanonicalDiscriminatedUnionJsonSchema<T extends z.ZodTypeAny>(
  schema: T,
  description?: string,
): T {
  const advertisedSchema = description ? (schema.describe(description) as T) : schema;
  return withJsonSchemaOverride(advertisedSchema, (jsonSchema) => {
    if (description) {
      jsonSchema.description = description;
    }
  });
}

/**
 * Normalize an advertised tool INPUT JSON Schema in place to the Anthropic
 * `input_schema` supported subset. Anthropic rejects root-level combinators and
 * does not support `oneOf`/`if`/`then`/`else`/`not` (even nested). Nested
 * `anyOf`/`allOf` are supported and preserved. This ONLY mutates the advertised
 * JSON; the source-of-truth zod schema (runtime validation) is untouched.
 */
export function enforceAnthropicToolSchemaSubset(jsonSchema: Record<string, unknown>): void {
  normalizeAnthropicSchemaNode(jsonSchema);

  if (Object.hasOwn(jsonSchema, "allOf")) {
    const allOf = jsonSchema.allOf;
    if (Array.isArray(allOf)) {
      mergeRootAllOf(jsonSchema, allOf);
    }
    delete jsonSchema.allOf;
  }

  for (const key of ["anyOf", "oneOf", "not", "if", "then", "else"] as const) {
    if (Object.hasOwn(jsonSchema, key)) {
      throw new Error(`Anthropic input schema has unsupported root ${key}`);
    }
  }

  if (jsonSchema.type !== "object") {
    throw new Error("Anthropic input schema root must have type object");
  }
}

function normalizeAnthropicSchemaNode(node: Record<string, unknown>): void {
  delete node.if;
  delete node.then;
  delete node.else;
  delete node.not;

  const oneOf = node.oneOf;
  if (Array.isArray(oneOf)) {
    const anyOf = node.anyOf;
    node.anyOf = Array.isArray(anyOf) ? [...anyOf, ...oneOf] : oneOf;
  }
  delete node.oneOf;

  normalizeSchemaObjectValues(node.properties);
  normalizeSchemaObjectValues(node.$defs);
  normalizeSchemaObjectValues(node.definitions);
  normalizeSchemaNodes(node.items);
  normalizeSchemaArray(node.prefixItems);
  normalizeSchemaNode(node.additionalProperties);
  normalizeSchemaArray(node.anyOf);
  normalizeSchemaArray(node.allOf);
  normalizeSchemaNode(node.contains);
  normalizeSchemaObjectValues(node.patternProperties);

  pruneEmptySchemaBranches(node, "anyOf");
  pruneEmptySchemaBranches(node, "allOf");
}

function normalizeSchemaObjectValues(value: unknown): void {
  if (!isJsonObject(value)) {
    return;
  }
  Object.values(value).forEach(normalizeSchemaNode);
}

function normalizeSchemaNode(value: unknown): void {
  if (isJsonObject(value)) {
    normalizeAnthropicSchemaNode(value);
  }
}

function normalizeSchemaNodes(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(normalizeSchemaNode);
  } else {
    normalizeSchemaNode(value);
  }
}

function normalizeSchemaArray(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(normalizeSchemaNode);
  }
}

function pruneEmptySchemaBranches(node: Record<string, unknown>, key: "anyOf" | "allOf"): void {
  const branches = node[key];
  if (!Array.isArray(branches)) {
    return;
  }
  const nonEmptyBranches = branches.filter(
    (branch) => !isJsonObject(branch) || Object.keys(branch).length > 0,
  );
  if (nonEmptyBranches.length === 0) {
    delete node[key];
  } else {
    node[key] = nonEmptyBranches;
  }
}

function mergeRootAllOf(root: Record<string, unknown>, allOf: unknown[]): void {
  const rootProperties = getJsonObject(root.properties) ?? {};
  const rootRequired = getRequiredProperties(root);

  for (const branch of allOf) {
    if (!isJsonObject(branch)) {
      continue;
    }
    const branchProperties = getJsonObject(branch.properties);
    if (branchProperties) {
      Object.assign(rootProperties, branchProperties);
    }
    rootRequired.push(...getRequiredProperties(branch));
  }

  if (Object.keys(rootProperties).length > 0) {
    root.properties = rootProperties;
  }
  if (rootRequired.length > 0) {
    root.required = [...new Set(rootRequired)];
  }
}

function getRequiredProperties(branch: Record<string, unknown>): string[] {
  const required = branch.required;
  return Array.isArray(required) && required.every((value) => typeof value === "string")
    ? required
    : [];
}

function getJsonObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function applyJsonSchemaOverride(
  zodSchema: object,
  jsonSchema: Record<string, unknown>,
): void {
  jsonSchemaOverrides.get(zodSchema)?.(jsonSchema);
}

export function applyPostFlattenJsonSchemaOverride(
  zodSchema: object,
  jsonSchema: Record<string, unknown>,
): void {
  postFlattenJsonSchemaOverrides.get(zodSchema)?.(jsonSchema);
}

export function isInjectedDeviceIdSchema(zodSchema: object): boolean {
  if (injectedDeviceIdSchemas.has(zodSchema)) {
    return true;
  }
  return (
    zodSchema instanceof z.ZodObject && zodSchema.shape.deviceId === deviceTargetingShape.deviceId
  );
}

/**
 * Compacts advertised "exactly one of" selector properties. `z.union([...strict
 * objects])` (the elementId/text/textAny selectors, `container`, etc.) expands to
 * an `anyOf` where every branch re-inlines a full object schema — costly in
 * `tools/list`. When a named property matches that pattern (each branch a strict
 * object requiring exactly one key), rewrite it to a single flat object that
 * lists all keys once with `anyOf: [{required:[k]}, ...]` — same accepted shape
 * and the same "exactly one" hint at roughly half the tokens.
 *
 * Runtime validation is unaffected: this only mutates the advertised JSON schema
 * (via `withJsonSchemaOverride`); the source-of-truth zod union is untouched.
 * Non-matching properties are left as-is.
 */
export function compactExclusiveSelectorProperties(
  jsonSchema: Record<string, unknown>,
  propNames: readonly string[],
): void {
  const props = jsonSchema.properties as Record<string, any> | undefined;
  if (!props) {
    return;
  }
  for (const name of propNames) {
    const prop = props[name];
    const branches: unknown = prop?.anyOf ?? prop?.oneOf;
    if (!Array.isArray(branches) || branches.length < 2) {
      continue;
    }
    const merged: Record<string, unknown> = {};
    const anyOf: Array<{ required: string[] }> = [];
    let matchesPattern = true;
    for (const branch of branches) {
      const b = branch as Record<string, any>;
      if (
        b?.type !== "object" ||
        typeof b.properties !== "object" ||
        !Array.isArray(b.required) ||
        b.required.length !== 1
      ) {
        matchesPattern = false;
        break;
      }
      const key = b.required[0] as string;
      if (!(key in b.properties)) {
        matchesPattern = false;
        break;
      }
      merged[key] = b.properties[key];
      anyOf.push({ required: [key] });
    }
    if (!matchesPattern) {
      continue;
    }
    const compact: Record<string, unknown> = {
      type: "object",
      additionalProperties: false,
      properties: merged,
    };
    if (typeof prop.description === "string") {
      compact.description = prop.description;
    }
    compact.anyOf = anyOf;
    props[name] = compact;
  }
}

export function withFieldAliases<T extends z.ZodTypeAny>(schema: T, aliases: FieldAliasMap): T {
  const aliased = z.preprocess(
    (input) => normalizeFieldAliases(input, aliases),
    schema,
  ) as unknown as T;
  if (isInjectedDeviceIdSchema(schema)) {
    injectedDeviceIdSchemas.add(aliased);
  }
  return aliased;
}

export function withAppIdAliases<T extends z.ZodTypeAny>(schema: T): T {
  const appIdAliases = withFieldAliases(schema, { appId: appIdFieldAliases }).superRefine(
    (value, ctx) => {
      validateAppIds(value, ctx);
    },
  );
  return appIdAliases as T;
}

function validateAppIds(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateAppIds(item, ctx, [...path, index]));
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = [...path, key];
    if (key === "appId" && typeof nestedValue === "string") {
      const result = appIdSchema.safeParse(nestedValue);
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          path: nestedPath,
          message: result.error.issues[0]?.message ?? "appId must be a valid application ID",
        });
      }
    }
    validateAppIds(nestedValue, ctx, nestedPath);
  }
}

function normalizeFieldAliases(input: unknown, aliases: FieldAliasMap): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeFieldAliases(item, aliases));
  }

  if (!isPlainObject(input)) {
    return input;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    normalized[key] = normalizeFieldAliases(value, aliases);
  }

  for (const [canonicalField, fieldAliases] of Object.entries(aliases)) {
    if (normalized[canonicalField] === undefined) {
      const matchingAlias = fieldAliases.find((alias) => normalized[alias] !== undefined);
      if (matchingAlias) {
        normalized[canonicalField] = normalized[matchingAlias];
      }
    }

    for (const alias of fieldAliases) {
      delete normalized[alias];
    }
  }

  if (typeof normalized.appId === "string") {
    normalized.appId = normalized.appId.trim();
  }

  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Fields added by {@link addSessionUuidToSchema}. */
const sessionUuidShape = {
  sessionUuid: z.string().optional().describe("Session"),
  keepScreenAwake: z.boolean().optional(),
};

/**
 * Device-targeting fields added by {@link addDeviceTargetingToSchema}:
 *
 * - `sessionUuid` / `keepScreenAwake` enable session-based device assignment.
 * - `device` is the device label; authored plans should prefer labels over
 *   concrete device IDs, because runtime device IDs are not known ahead of
 *   execution.
 * - `deviceId` exists so the executor can inject a resolved deviceId into
 *   requiresDevice tool calls after device allocation without tripping strict
 *   schema validation.
 * - `platform` is only applied when the base schema does not already define
 *   its own (possibly stricter) platform field.
 */
const deviceTargetingShape = {
  // Field order is load-bearing for schemas/tool-definitions.json: it must
  // match the historical helper-composition order (platform first).
  platform: platformSchema.optional(),
  ...sessionUuidShape,
  device: z.string().optional().describe(DEVICE_LABEL_DESCRIPTION),
  deviceId: z.string().optional(),
};

/**
 * Extend a schema with additional fields while preserving the base schema's
 * inferred type. Keys already present in the base shape keep the base
 * definition (used for `platform`, where some schemas declare a stricter
 * required/defaulted field).
 *
 * The cast is safe: at runtime the result is `schema.extend(...)` with base
 * keys taking precedence, which matches the declared intersection type modulo
 * key-precedence (base keys win in both).
 */
function extendPreservingBase<T extends z.ZodObject<z.ZodRawShape>, S extends z.ZodRawShape>(
  schema: T,
  fields: S,
): z.ZodObject<Omit<S, keyof T["shape"]> & T["shape"]> {
  const added: Record<string, z.core.$ZodType> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (!(key in schema.shape)) {
      added[key] = field;
    }
  }
  return schema.extend(added) as unknown as z.ZodObject<Omit<S, keyof T["shape"]> & T["shape"]>;
}

/**
 * Helper to add sessionUuid field to tool schemas
 *
 * This enables session-based device assignment for tools that need it.
 * The sessionUuid parameter is optional and allows tools to be targeted
 * at specific devices through session context.
 */
export function addSessionUuidToSchema<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return extendPreservingBase(schema, sessionUuidShape);
}

/**
 * Helper to add sessionUuid + device label + deviceId + platform fields to tool schemas.
 */
export function addDeviceTargetingToSchema<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  const extended = extendPreservingBase(schema, deviceTargetingShape);
  if (!("deviceId" in schema.shape)) {
    injectedDeviceIdSchemas.add(extended);
  }
  return extended;
}
