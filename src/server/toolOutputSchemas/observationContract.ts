import { z } from "zod/v4";
import { boundsObjectSchema } from "./display";
import {
  withJsonSchemaOverride,
  withPostFlattenJsonSchemaOverride,
} from "../../utils/schemaHelpers";

/**
 * `observationId` is the join key for observation-scoped screenshot resources.
 * The runtime mints it on every emitted observation (`RealObserveScreen`), so
 * the advertised output contract lists it as required. The same zod schemas
 * also validate recorded captures that predate the field, so the parse schema
 * keeps it optional; {@link requireObservationJoinKeysOnTheWire} adds it to the
 * advertised JSON Schema `required` list without touching runtime validation.
 */
export const observationIdSchema = z
  .string()
  .optional()
  .describe("Observation-scoped screenshot resource URI join key.");

/**
 * The concrete device this observation resolved to and ran against (issue
 * #7018). Same wire contract as {@link observationIdSchema}: optional on parse
 * (recorded captures predate it) but advertised required on the wire, because a
 * client needs BOTH `deviceId` and `observationId` to build the
 * observation-scoped screenshot resource URI.
 */
export const observationDeviceIdSchema = z
  .string()
  .optional()
  .describe(
    "Resolved device this observation ran against; join key (with observationId) for the observation-scoped screenshot resource.",
  );

/**
 * Fully-encoded observation-scoped screenshot resource URI (issue #7018), built
 * from `deviceId` + `observationId` so a client can read the paired screenshot
 * without assembling the URI itself. Same wire contract as
 * {@link observationIdSchema}.
 */
export const observationScreenshotResourceUriSchema = z
  .string()
  .optional()
  .describe(
    "Fully-encoded automobile:observation/{deviceId}/{observationId}/screenshot resource URI for this observation.",
  );

export const observationRotationSchema = z
  .number()
  .int()
  .min(0)
  .max(3)
  .optional()
  .describe(
    "Rotation: 0 portrait; 1 landscape with device top toward the left (counter-clockwise, iOS landscapeLeft / Android ROTATION_90); 2 portrait upside down; 3 landscape right (iOS landscapeRight / Android ROTATION_270). iOS prefers runner interface orientation, preserving portrait on unfolded landscape-shaped panels and reconciling landscape on fixed portrait displays to 0. Without runner orientation, settled screen shape distinguishes only 0 (width < height) or 1 (width >= height, including square screens).",
  );

export const snapshotReferenceSchema = z
  .object({ snapshotId: z.string(), expiresAt: z.number() })
  .optional()
  .describe("Process-local full-screen coordinate reference; expires after at most five minutes.");

export const snapshotReferenceUnavailableSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Missing snapshot capture preconditions (display, screenSize, rotation, nativeScale, frameContext, completeHierarchy); only present when a session observe could not produce a reference.",
  );

const cropNativeBoundsSchema = boundsObjectSchema
  .pick({ left: true, top: true, right: true, bottom: true })
  .strict();

const screenshotRasterFields = {
  imageSize: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .strict(),
  pixelsPerNativeUnit: z.object({ x: z.number().positive(), y: z.number().positive() }).strict(),
  scaleProvenance: z.enum(["raster-dimensions", "native-scale-confirmed"]),
};

export const observeCropResultSchema = z
  .object({
    cropPath: z.string(),
    expiresAt: z.number().optional(),
    unit: z.enum(["pixels", "points"]),
    requestedBounds: cropNativeBoundsSchema,
    clippedBounds: cropNativeBoundsSchema,
    clipped: z.boolean(),
    screenSize: z.object({ width: z.number().positive(), height: z.number().positive() }).strict(),
    ...screenshotRasterFields,
    imageSize: screenshotRasterFields.imageSize.describe(
      "Pixel dimensions of the upright output crop PNG.",
    ),
    rasterBounds: z
      .object({
        left: z.number().int().nonnegative(),
        top: z.number().int().nonnegative(),
        right: z.number().int().positive(),
        bottom: z.number().int().positive(),
      })
      .strict()
      .describe(
        "Bounds read from the captured source raster before crop orientation normalization.",
      ),
    screenshotOrientation: z
      .enum(["display", "native"])
      .describe(
        "Orientation of the output crop PNG; display after native iOS quarter/half-turn normalization. The full screenshot retains its own orientation metadata.",
      ),
  })
  .strict();

export const observationScreenshotOutputFields = {
  screenshotImageSize: screenshotRasterFields.imageSize.optional(),
  screenshotPixelsPerNativeUnit: screenshotRasterFields.pixelsPerNativeUnit.optional(),
  screenshotScaleProvenance: screenshotRasterFields.scaleProvenance.optional(),
  screenshotIncludesPrototype: z.boolean().optional(),
  screenshotSettled: z.boolean().optional(),
  screenshotSettledError: z.string().optional(),
  screenshotOrientation: z.enum(["native", "display"]).optional(),
  screenshotPath: z.string().optional(),
  screenshotExpiresAt: z.number().optional(),
  screenshotSource: z.enum(["fresh", "cached"]).optional(),
  screenshotCaptureSource: z.enum(["device", "observation-cache"]).optional(),
  screenshotCapturedAt: z.string().optional(),
  screenshotAgeMs: z.number().optional(),
  screenshotFreshFailure: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .optional(),
  screenshotFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  screenshotMimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
  screenshotImage: z
    .union([
      z.object({ included: z.literal(true), mimeType: z.string(), sizeBytes: z.number() }),
      z.object({
        included: z.literal(false),
        reason: z.string(),
        sizeBytes: z.number().optional(),
        capBytes: z.number().optional(),
      }),
    ])
    .optional(),
};

/**
 * Observation screenshot-resource properties (issue #7018). All three stay
 * optional on the zod parse schema so recorded captures that predate them still
 * validate. The URI is declared but not wire-required: observations that
 * deliberately skip capture have no screenshot resource to advertise.
 */
const OBSERVATION_JOIN_KEY_PROPERTIES = [
  "observationId",
  "deviceId",
  "display",
  "observationScreenshotResourceUri",
] as const;

/** Identity keys every successful observation has on the advertised wire contract. */
const OBSERVATION_WIRE_REQUIRED_KEYS = ["observationId", "deviceId", "display"] as const;

/**
 * Advertise the observation join keys as required (in property order, so the
 * generated `required` list is stable) while the zod schema still parses
 * captures that omit them. Registers by schema identity, so call it on the
 * final exported schema object. It detects every declared screenshot-resource
 * property, but promotes only the identity keys; the URI remains optional.
 */
export function requireObservationJoinKeysOnTheWire(schema: z.ZodTypeAny): void {
  withJsonSchemaOverride(schema, (jsonSchema) => {
    const properties = jsonSchema.properties as Record<string, unknown> | undefined;
    if (!properties) {
      return;
    }
    const required = new Set(Array.isArray(jsonSchema.required) ? jsonSchema.required : []);
    const joinKeyProperties = OBSERVATION_JOIN_KEY_PROPERTIES.filter((key) =>
      Object.hasOwn(properties, key),
    );
    if (joinKeyProperties.length === 0) {
      return;
    }
    for (const key of OBSERVATION_WIRE_REQUIRED_KEYS) {
      if (Object.hasOwn(properties, key)) {
        required.add(key);
      }
    }
    // Keep `additionalProperties` as the trailing key so the generated
    // `schemas/tool-definitions.json` stays byte-stable.
    const { additionalProperties, ...rest } = jsonSchema;
    for (const key of Object.keys(jsonSchema)) {
      delete jsonSchema[key];
    }
    Object.assign(jsonSchema, rest, {
      required: Object.keys(properties).filter((key) => required.has(key)),
    });
    if (additionalProperties !== undefined) {
      jsonSchema.additionalProperties = additionalProperties;
    }
  });
}

/**
 * The advertised output schema of the `observe` tool is a `z.union` of the
 * ordinary observation ({@link observeResultSchema}) and the hard-ceiling
 * artifact-spill metadata ({@link toolOutputArtifactMetadataSchema}). The
 * registry flattens that top-level union into ONE object schema for `tools/list`
 * (top-level `anyOf`/`oneOf` is rejected by the Anthropic API and many MCP
 * clients), and flattening reduces each arm's `required` to the cross-arm
 * intersection — dropping the join keys entirely — then re-homes the observe
 * arm's arm-only `required` under whatever single-const property it finds first
 * (`accessibilityAuditSkipped`). That leaves the join keys advertised as required
 * ONLY when `accessibilityAuditSkipped` is present, so an ordinary successful
 * observation wrongly advertises them as optional (issue #7018).
 *
 * A per-node {@link requireObservationJoinKeysOnTheWire} cannot fix this: it runs
 * before flattening. Re-assert the contract on the POST-flatten object instead —
 * the join keys are required on the successful-observation arm (every shape
 * except the artifact spill, which is the only arm carrying `artifact`), not on
 * the artifact/spill arm where they do not apply. The requirement is expressed as
 * an `if artifact present -> then no join keys / else join keys required`
 * conditional, the same `if/then/else` construct the flattener already emits for
 * branch-only required fields.
 */
export function requireObservationJoinKeysOnFlattenedUnion(schema: z.ZodTypeAny): void {
  withPostFlattenJsonSchemaOverride(schema, (jsonSchema) => {
    const properties = jsonSchema.properties as Record<string, unknown> | undefined;
    if (!properties) {
      return;
    }
    const joinKeyProperties = OBSERVATION_JOIN_KEY_PROPERTIES.filter((key) =>
      Object.hasOwn(properties, key),
    );
    const requiredJoinKeys = OBSERVATION_WIRE_REQUIRED_KEYS.filter((key) =>
      Object.hasOwn(properties, key),
    );
    // Only act on the flattened observe union: it declares the join keys and the
    // `artifact` spill arm's discriminating property.
    if (joinKeyProperties.length === 0 || !Object.hasOwn(properties, "artifact")) {
      return;
    }
    // The flattener emits a single `if/then` (no `else`) whose `then.required` is
    // exactly the observe arm's arm-only required (the join keys) gated on a
    // bogus discriminator. Only rewrite when the pre-flatten conditional is
    // either absent or exactly that join-key requirement; if it is anything else
    // (a future arm added its own branch-only required), bail rather than clobber
    // it — the assumptions here no longer hold and must be revisited deliberately.
    const then = jsonSchema.then as { required?: unknown } | undefined;
    const thenRequired = Array.isArray(then?.required) ? (then.required as string[]) : undefined;
    const hasConditional = "if" in jsonSchema || "then" in jsonSchema || "else" in jsonSchema;
    const isJoinKeyOnlyConditional =
      !("else" in jsonSchema) &&
      thenRequired !== undefined &&
      thenRequired.every((key) => (requiredJoinKeys as string[]).includes(key));
    if (hasConditional && !isJoinKeyOnlyConditional) {
      return;
    }
    delete jsonSchema.if;
    delete jsonSchema.then;
    delete jsonSchema.else;
    // Require the join keys on every shape except the artifact spill arm.
    jsonSchema.if = { required: ["artifact"] };
    jsonSchema.then = {};
    jsonSchema.else = { required: [...requiredJoinKeys] };
  });
}
