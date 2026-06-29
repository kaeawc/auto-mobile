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

/**
 * Helper to add sessionUuid field to tool schemas
 *
 * This enables session-based device assignment for tools that need it.
 * The sessionUuid parameter is optional and allows tools to be targeted
 * at specific devices through session context.
 */
export function addSessionUuidToSchema<T extends z.ZodObject<any>>(schema: T): z.ZodObject<any> {
  return schema.extend({
    sessionUuid: z.string().optional().describe("Session"),
    keepScreenAwake: z.boolean().optional(),
  }) as z.ZodObject<any>;
}

/**
 * Helper to add device label field to tool schemas.
 */
function addDeviceLabelToSchema<T extends z.ZodObject<any>>(schema: T): z.ZodObject<any> {
  return schema.extend({
    device: z.string().optional().describe(DEVICE_LABEL_DESCRIPTION),
  }) as z.ZodObject<any>;
}

/**
 * Helper to add deviceId field to tool schemas.
 *
 * Authored plans should prefer device labels (`device`) rather than concrete
 * device IDs, because runtime device IDs are not known ahead of execution.
 *
 * The executor may still inject a resolved deviceId into requiresDevice tool
 * calls after device allocation. Tools with strict schemas must explicitly
 * declare deviceId to avoid validation failures for that internal injection.
 */
function addDeviceIdToSchema<T extends z.ZodObject<any>>(schema: T): z.ZodObject<any> {
  return schema.extend({
    deviceId: z.string().optional(),
  }) as z.ZodObject<any>;
}

/**
 * Helper to add optional platform field only when the base schema doesn't already define one.
 */
function addPlatformToSchema<T extends z.ZodObject<any>>(schema: T): z.ZodObject<any> {
  if ("platform" in schema.shape) {
    return schema;
  }
  return schema.extend({
    platform: platformSchema.optional(),
  }) as z.ZodObject<any>;
}

/**
 * Helper to add sessionUuid + device label + deviceId + platform fields to tool schemas.
 */
export function addDeviceTargetingToSchema<T extends z.ZodObject<any>>(schema: T): z.ZodObject<any> {
  return addDeviceIdToSchema(addDeviceLabelToSchema(addSessionUuidToSchema(addPlatformToSchema(schema))));
}
