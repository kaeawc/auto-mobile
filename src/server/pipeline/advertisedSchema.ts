import { toJSONSchema } from "zod/v4";
import { flattenTopLevelUnion } from "../TopLevelUnionFlattener";
import { visitJsonSchemaAlternatives } from "../jsonSchemaReferences";
import {
  dropDefaultedKeysFromRequired,
  dropReferencedDefaultsFromRequired,
} from "./advertisedSchemaDefaults";
import {
  APP_ID_MAX_LENGTH,
  APP_ID_PATTERN,
  applyJsonSchemaOverride,
  applyPostFlattenJsonSchemaOverride,
  enforceAnthropicToolSchemaSubset,
  isInjectedDeviceIdSchema,
} from "../../utils/schemaHelpers";
import { toolOutputArtifactDetailsSchema } from "../toolOutputSchemas";
import {
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
} from "../../daemon/wire/constants";

/** The transport-deadline keys a plan step must never carry: plan content cannot pick a deadline. */
const PLAN_STEP_DEADLINE_PARAMS = [
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
] as const;

/**
 * A plan step's args without any transport-deadline key the plan supplied. A step runs under the
 * enclosing request's ambient deadline (#15663); a key left in its args would be an unrecognized
 * key to a `.strict()` tool schema (getAndroid/getApple/provisionDevice) and reject the step.
 */
export function withoutPlanSuppliedDeadlineParams(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!PLAN_STEP_DEADLINE_PARAMS.some((key) => Object.hasOwn(args, key))) {
    return args;
  }
  const stripped = { ...args };
  for (const key of PLAN_STEP_DEADLINE_PARAMS) {
    delete stripped[key];
  }
  return stripped;
}

/** Apply the app ID contract after every per-node and whole-schema transformation. */
function constrainAdvertisedAppIdProperties(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(constrainAdvertisedAppIdProperties);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const jsonSchema = value as Record<string, unknown>;
  const properties = jsonSchema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const appId = (properties as Record<string, unknown>).appId;
    if (appId && typeof appId === "object" && !Array.isArray(appId)) {
      const appIdSchema = appId as Record<string, unknown>;
      appIdSchema.minLength = 1;
      appIdSchema.maxLength = APP_ID_MAX_LENGTH;
      appIdSchema.pattern = APP_ID_PATTERN.source;
    }
  }

  Object.values(jsonSchema).forEach(constrainAdvertisedAppIdProperties);
}

export function toAdvertisedJsonSchema(
  schema: any,
  options: {
    constrainAppIds: boolean;
    anthropicSubset?: boolean;
    exposeDeviceId?: boolean;
    reused?: "inline" | "ref";
  },
): Record<string, unknown> {
  const jsonSchema = toJSONSchema(schema, {
    reused: options.reused,
    override: ({ zodSchema, jsonSchema }) => {
      applyJsonSchemaOverride(zodSchema, jsonSchema);
      dropDefaultedKeysFromRequired(jsonSchema);
      if (isInjectedDeviceIdSchema(zodSchema) && !options.exposeDeviceId) {
        const properties = jsonSchema.properties as Record<string, unknown> | undefined;
        if (properties) {
          delete properties.deviceId;
        }
      }
    },
  });
  if (options.reused === "ref") {
    dropReferencedDefaultsFromRequired(jsonSchema);
  }
  const flattened = flattenTopLevelUnion(jsonSchema);
  // Re-assert any wire contract that must survive union flattening (e.g. the
  // observe join keys required on the successful-observation arm, issue #7018):
  // per-node overrides only saw the pre-flatten arm, whose arm-only `required`
  // flattening reduces to the cross-arm intersection or re-homes under a branch
  // discriminator. No-op for schemas without a registered post-flatten override.
  applyPostFlattenJsonSchemaOverride(schema, flattened);
  if (options.constrainAppIds) {
    constrainAdvertisedAppIdProperties(flattened);
  }
  if (options.anthropicSubset) {
    enforceAnthropicToolSchemaSubset(flattened);
  }
  return flattened;
}

const advertisedToolOutputArtifactDetailsSchema = toJSONSchema(toolOutputArtifactDetailsSchema);

/**
 * A hard-ceiling spill retains required headline fields and appends an artifact
 * pointer. Runtime Zod output schemas deliberately keep their normal unknown-key
 * behavior, so advertise that one possible runtime addition without admitting
 * arbitrary top-level output fields.
 */
export function addSpillArtifactToAdvertisedOutputSchema(
  jsonSchema: Record<string, unknown>,
): Record<string, unknown> {
  const addArtifactProperty = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    const objectNode = node as Record<string, unknown>;
    if (objectNode.type !== "object" || objectNode.additionalProperties !== false) {
      return;
    }
    const properties =
      objectNode.properties && typeof objectNode.properties === "object"
        ? (objectNode.properties as Record<string, unknown>)
        : {};
    if (Object.hasOwn(properties, "artifact")) {
      return;
    }
    objectNode.properties = {
      ...properties,
      artifact: advertisedToolOutputArtifactDetailsSchema,
    };
  };

  visitJsonSchemaAlternatives(jsonSchema, addArtifactProperty);
  return jsonSchema;
}
