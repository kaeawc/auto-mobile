import { ToolRegistry } from "../server/toolRegistry";
import { logger } from "../utils/logger";
import { initializeCliTools } from "./cliToolRegistration";

export interface DeclaredType {
  type: string;
  /** True when a JSON `null` is a legal value and must survive coercion. */
  nullable: boolean;
}

/** Parse a CLI token as JSON, reporting whether it was JSON at all. */
export function tryParseJsonToken(raw: string): { parsed: boolean; value: unknown } {
  try {
    return { parsed: true, value: JSON.parse(raw) };
  } catch (error) {
    // Plain tokens are expected CLI input, not an error.
    logger.debug(`[cli] value is not JSON, treating as a raw token: ${raw} (${error})`);
    return { parsed: false, value: raw };
  }
}

export function coerceCliValue(raw: string, declared: DeclaredType | undefined): unknown {
  const bestEffort = (): unknown => tryParseJsonToken(raw).value;
  if (declared?.nullable && raw === "null") {
    return null;
  }
  switch (declared?.type) {
    case "string":
    case "enum":
      return asDeclaredString(raw);
    case "number":
    case "bigint":
      return asDeclaredNumber(raw);
    case "boolean":
      if (raw === "true") {
        return true;
      }
      if (raw === "false") {
        return false;
      }
      return bestEffort();
    default:
      return bestEffort();
  }
}

export function asDeclaredString(raw: string): string {
  const { parsed, value } = tryParseJsonToken(raw);
  return parsed && typeof value === "string" ? value : raw;
}

export function asDeclaredNumber(raw: string): unknown {
  const { parsed, value } = tryParseJsonToken(raw);
  return parsed && typeof value === "number" && Number.isFinite(value) ? value : raw;
}

export const SCHEMA_WRAPPER_TYPES = new Set([
  "optional",
  "nullable",
  "default",
  "readonly",
  "catch",
  "branded",
  "lazy",
]);

/** The zod type name of a schema, normalized ("ZodString" -> "string"). */
export function schemaTypeName(schema: any): string {
  const raw = schema?._def?.typeName ?? schema?._def?.type ?? "unknown";
  return String(raw).replace(/^Zod/, "").toLowerCase();
}

/** The schema a wrapper wraps; the key varies across zod versions. */
export function unwrapSchema(schema: any): any {
  const definition = schema?._def;
  return definition?.innerType ?? definition?.type ?? definition?.schema ?? null;
}

export function resolveDeclaredType(schema: any): DeclaredType {
  let current = schema;
  let nullable = false;
  for (let depth = 0; depth < 10 && current; depth++) {
    const name = schemaTypeName(current);
    if (name === "nullable") {
      nullable = true;
    }
    if (name === "literal") {
      return { type: typeof (current._def?.value ?? current._def?.values?.[0]), nullable };
    }
    if (!SCHEMA_WRAPPER_TYPES.has(name)) {
      return { type: name, nullable };
    }
    current = unwrapSchema(current);
  }
  return { type: "unknown", nullable };
}

export function collectSchemaShapes(schema: any): Record<string, any>[] {
  const definition = schema?._def;
  if (!definition) {
    return [];
  }
  if (definition.shape) {
    return [definition.shape];
  }
  const options = definition.options ?? definition.out?._def?.options;
  if (Array.isArray(options)) {
    return options.flatMap((option: any) => collectSchemaShapes(option));
  }
  return definition.out ? collectSchemaShapes(definition.out) : [];
}

export function getDeclaredParamTypes(toolName: string): Record<string, DeclaredType> | null {
  initializeCliTools();
  const tool = ToolRegistry.getTool(toolName);
  if (!tool) {
    return null;
  }
  const shapes = collectSchemaShapes(tool.schema);
  if (shapes.length === 0) {
    return null;
  }
  const byParam = new Map<string, { types: Set<string>; nullable: boolean }>();
  for (const shape of shapes) {
    for (const [key, value] of Object.entries(shape)) {
      const declared = resolveDeclaredType(value);
      const entry = byParam.get(key) ?? { types: new Set<string>(), nullable: false };
      entry.types.add(declared.type);
      entry.nullable = entry.nullable || declared.nullable;
      byParam.set(key, entry);
    }
  }
  return Object.fromEntries(
    [...byParam.entries()]
      .filter(([, entry]) => entry.types.size === 1)
      .map(([key, entry]) => [key, { type: [...entry.types][0], nullable: entry.nullable }]),
  );
}
