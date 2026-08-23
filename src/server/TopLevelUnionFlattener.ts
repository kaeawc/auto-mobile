/**
 * Top-level union schema flattening.
 *
 * The Anthropic API (and many MCP clients) reject tool input schemas that have
 * top-level combinators such as `anyOf`, `oneOf`, or `allOf`. Zod's `z.union()`
 * produces `anyOf`/`oneOf`. The helpers here flatten union branches into a single
 * `type: "object"` schema by merging all properties from every branch.
 *
 * Extracted from `toolRegistry.ts` so the flattening logic is a small, pure,
 * independently-testable unit rather than one of several concerns folded into
 * the registry. See {@link flattenTopLevelUnion} for the entry point.
 */

/**
 * Flatten a schema's top-level `anyOf`/`oneOf` union into a single object schema.
 *
 * Required fields are reduced to the intersection across branches because
 * different branches require different keys; branch-only required fields are
 * preserved as `if/then` conditional requirements keyed off a discriminator.
 *
 * Trade-off: the flattened schema loses mutual-exclusivity information, so LLMs may
 * send invalid property combinations or omit branch-specific required fields. The
 * server-side Zod union still validates at runtime.
 */
export function flattenTopLevelUnion(schema: Record<string, unknown>): Record<string, unknown> {
  const branches = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
  if (!branches || !Array.isArray(branches)) {
    return schema;
  }

  // Null-prototype map: a `{}` here inherits `Object.prototype`, so the
  // `!mergedProperties[key]` guard below would read the inherited member for a
  // property named `constructor`/`toString`/`__proto__`/... and merge the real
  // branch schema into it, silently corrupting the emitted schema (issue #4187).
  const mergedProperties: Record<string, unknown> = Object.create(null);
  const seenAdditionalProperties = new Set<boolean | undefined>();
  const requiredSets: Set<string>[] = [];

  for (const branch of branches) {
    const props = branch.properties as Record<string, unknown> | undefined;
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (!mergedProperties[key]) {
          mergedProperties[key] = value;
        } else {
          mergedProperties[key] = mergeUnionProperty(mergedProperties[key], value);
        }
      }
    }
    if (typeof branch.additionalProperties === "boolean") {
      seenAdditionalProperties.add(branch.additionalProperties);
    }
    const req = branch.required as string[] | undefined;
    requiredSets.push(new Set(req ?? []));
  }

  const commonRequired =
    requiredSets.length > 0
      ? [...requiredSets[0]].filter((key) => requiredSets.every((s) => s.has(key)))
      : [];

  const result: Record<string, unknown> = {
    ...("$schema" in schema ? { $schema: schema.$schema } : {}),
    ...("$id" in schema ? { $id: schema.$id } : {}),
    ...("$defs" in schema ? { $defs: schema.$defs } : {}),
    ...("definitions" in schema ? { definitions: schema.definitions } : {}),
    type: "object",
    properties: mergedProperties,
  };

  if (commonRequired.length > 0) {
    result.required = commonRequired;
  }

  if (seenAdditionalProperties.size === 1) {
    result.additionalProperties = [...seenAdditionalProperties][0];
  }

  const conditionalRequired = buildConditionalRequired(branches, commonRequired);
  if (conditionalRequired) {
    Object.assign(result, conditionalRequired);
  }

  return result;
}

interface ConditionalRequirement {
  if: {
    properties: Record<string, { const: unknown }>;
    required: string[];
  };
  then: {
    required: string[];
  };
  else?: ConditionalRequirement;
}

function buildConditionalRequired(
  branches: Record<string, unknown>[],
  commonRequired: string[],
): ConditionalRequirement | undefined {
  const commonRequiredSet = new Set(commonRequired);
  const requirements: ConditionalRequirement[] = [];

  for (const branch of branches) {
    const required = Array.isArray(branch.required)
      ? branch.required.filter((key): key is string => typeof key === "string")
      : [];
    const branchOnlyRequired = required.filter((key) => !commonRequiredSet.has(key));
    if (branchOnlyRequired.length === 0) {
      continue;
    }

    const condition = buildDiscriminatorCondition(branch);
    if (!condition) {
      continue;
    }

    requirements.push({
      if: condition,
      then: {
        required: branchOnlyRequired,
      },
    });
  }

  return chainConditionalRequirements(requirements);
}

function buildDiscriminatorCondition(
  branch: Record<string, unknown>,
): ConditionalRequirement["if"] | undefined {
  const properties = isJsonSchemaObject(branch.properties) ? branch.properties : {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isJsonSchemaObject(value)) {
      continue;
    }
    const values = constOrEnumValues(value);
    if (values.length !== 1) {
      continue;
    }
    return {
      properties: {
        [key]: { const: values[0] },
      },
      required: [key],
    };
  }
  return undefined;
}

function chainConditionalRequirements(
  requirements: ConditionalRequirement[],
): ConditionalRequirement | undefined {
  let chain: ConditionalRequirement | undefined;

  for (const requirement of requirements.toReversed()) {
    chain = {
      ...requirement,
      ...(chain ? { else: chain } : {}),
    };
  }

  return chain;
}

function mergeUnionProperty(existing: unknown, incoming: unknown): unknown {
  if (!isJsonSchemaObject(existing) || !isJsonSchemaObject(incoming)) {
    return existing;
  }

  const existingValues = constOrEnumValues(existing);
  const incomingValues = constOrEnumValues(incoming);
  if (existingValues.length === 0 || incomingValues.length === 0) {
    return existing;
  }

  const baseSchema = { ...existing };
  delete baseSchema.const;
  return {
    ...baseSchema,
    enum: [...new Set([...existingValues, ...incomingValues])],
  };
}

function constOrEnumValues(schema: Record<string, unknown>): unknown[] {
  if ("const" in schema) {
    return [schema.const];
  }
  return Array.isArray(schema.enum) ? schema.enum : [];
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
