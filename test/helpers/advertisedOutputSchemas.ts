import type { z } from "zod/v4";
import { advertiseBoundsForCompact } from "../../src/server/compactBoundsAdvertisement";
import {
  addSpillArtifactToAdvertisedOutputSchema,
  toAdvertisedJsonSchema,
} from "../../src/server/pipeline/advertisedSchema";

/** The previous inline advertisement and the new advertisement share all wire overrides. */
export function advertisedOutputSchema(schema: z.ZodType, reused: "inline" | "ref") {
  return advertiseBoundsForCompact(
    addSpillArtifactToAdvertisedOutputSchema(
      toAdvertisedJsonSchema(schema, { constrainAppIds: false, reused }),
    ),
    true,
  ) as Record<string, unknown>;
}

export function jsonSchemaObjects(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    return node.flatMap(jsonSchemaObjects);
  }
  if (!node || typeof node !== "object") {
    return [];
  }
  return [node as Record<string, unknown>, ...Object.values(node).flatMap(jsonSchemaObjects)];
}
