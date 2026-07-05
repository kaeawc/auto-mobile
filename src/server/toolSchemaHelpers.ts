import { z } from "zod";

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

export function withFieldAliases<T extends z.ZodTypeAny>(schema: T, aliases: FieldAliasMap): T {
  return z.preprocess(input => normalizeFieldAliases(input, aliases), schema) as unknown as T;
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
  return extendPreservingBase(schema, deviceTargetingShape);
}
