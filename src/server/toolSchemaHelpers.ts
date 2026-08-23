import { z } from "zod/v4";

/** Shared platform schema — single source of truth for all tool schemas. */
export const platformSchema = z.enum(["android", "ios"]);

export const DEVICE_LABEL_DESCRIPTION =
  "Device label";

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

export type FieldAliasMap = Record<string, readonly string[]>;

export type JsonSchemaOverride = (jsonSchema: Record<string, unknown>) => void;

const jsonSchemaOverrides = new WeakMap<object, JsonSchemaOverride>();
const injectedDeviceIdSchemas = new WeakSet<object>();

export function withJsonSchemaOverride<T extends z.ZodTypeAny>(schema: T, override: JsonSchemaOverride): T {
  jsonSchemaOverrides.set(schema, override);
  return schema;
}

export function withCanonicalDiscriminatedUnionJsonSchema<T extends z.ZodTypeAny>(
  schema: T,
  description?: string,
): T {
  const advertisedSchema = description ? (schema.describe(description) as T) : schema;
  return withJsonSchemaOverride(advertisedSchema, (jsonSchema) => {
    if (Array.isArray(jsonSchema.anyOf)) {
      jsonSchema.oneOf = jsonSchema.anyOf;
      delete jsonSchema.anyOf;
    }
    if (description) {
      jsonSchema.description = description;
    }
  });
}

export function applyJsonSchemaOverride(
  zodSchema: object,
  jsonSchema: Record<string, unknown>
): void {
  jsonSchemaOverrides.get(zodSchema)?.(jsonSchema);
}

export function isInjectedDeviceIdSchema(zodSchema: object): boolean {
  if (injectedDeviceIdSchemas.has(zodSchema)) {
    return true;
  }
  return zodSchema instanceof z.ZodObject && zodSchema.shape.deviceId === deviceTargetingShape.deviceId;
}

/**
 * Compacts advertised "exactly one of" selector properties. `z.union([...strict
 * objects])` (the elementId/text/textAny selectors, `container`, etc.) expands to
 * an `anyOf` where every branch re-inlines a full object schema — costly in
 * `tools/list`. When a named property matches that pattern (each branch a strict
 * object requiring exactly one key), rewrite it to a single flat object that
 * lists all keys once with `oneOf: [{required:[k]}, ...]` — same accepted shape
 * and the same "exactly one" hint at roughly half the tokens.
 *
 * Runtime validation is unaffected: this only mutates the advertised JSON schema
 * (via `withJsonSchemaOverride`); the source-of-truth zod union is untouched.
 * Non-matching properties are left as-is.
 */
export function compactExclusiveSelectorProperties(
  jsonSchema: Record<string, unknown>,
  propNames: readonly string[]
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
    const oneOf: Array<{ required: string[] }> = [];
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
      oneOf.push({ required: [key] });
    }
    if (!matchesPattern) {
      continue;
    }
    const compact: Record<string, unknown> = {
      type: "object",
      additionalProperties: false,
      properties: merged,
      oneOf,
    };
    if (typeof prop.description === "string") {
      compact.description = prop.description;
    }
    props[name] = compact;
  }
}

export function withFieldAliases<T extends z.ZodTypeAny>(schema: T, aliases: FieldAliasMap): T {
  const aliased = z.preprocess(input => normalizeFieldAliases(input, aliases), schema) as unknown as T;
  if (isInjectedDeviceIdSchema(schema)) {
    injectedDeviceIdSchemas.add(aliased);
  }
  return aliased;
}

export function withAppIdAliases<T extends z.ZodTypeAny>(schema: T): T {
  return withFieldAliases(schema, { appId: appIdFieldAliases });
}

function normalizeFieldAliases(input: unknown, aliases: FieldAliasMap): unknown {
  if (Array.isArray(input)) {
    return input.map(item => normalizeFieldAliases(item, aliases));
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
      const matchingAlias = fieldAliases.find(alias => normalized[alias] !== undefined);
      if (matchingAlias) {
        normalized[canonicalField] = normalized[matchingAlias];
      }
    }

    for (const alias of fieldAliases) {
      delete normalized[alias];
    }
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
  fields: S
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
