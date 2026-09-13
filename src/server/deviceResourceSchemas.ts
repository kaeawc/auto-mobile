import { z } from "zod/v4";
import { androidResourceRestorationSchema } from "../models/AndroidResourceRestoration";
import {
  DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../utils/deviceTimeouts";
import { addDeviceTargetingToSchema, withJsonSchemaOverride } from "./toolSchemaHelpers";
import {
  deviceResourceDescriptions,
  type ConfigurableDeviceResource,
} from "../models/deviceResourceDescriptions";

const requestedState = z.enum(["enabled", "disabled"]).optional();
// Object.fromEntries loses literal keys; every key is supplied by the typed catalog.
const resourceShape = Object.fromEntries(
  Object.entries(deviceResourceDescriptions).map(([key, description]) => [
    key,
    requestedState.describe(description),
  ]),
) as Record<ConfigurableDeviceResource, typeof requestedState>;

export const deviceResourceConfigurationSchema = withJsonSchemaOverride(
  z
    .object(resourceShape)
    .strict()
    .refine(
      (value) => Object.values(value).some((state) => state !== undefined),
      "Specify at least one resource. Omitted resources remain unchanged.",
    ),
  (jsonSchema) => {
    jsonSchema.minProperties = 1;
  },
);

export const setDeviceResourcesSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        resources: deviceResourceConfigurationSchema.optional(),
        restore: androidResourceRestorationSchema
          .optional()
          .describe(
            "Restore exact prior Android overrides from a returned receipt. Requires the same boot and user. Specify resources or restore, never both.",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(MAX_DEVICE_READY_TIMEOUT_MS)
          .optional()
          .describe(
            `Total configuration budget in milliseconds. Defaults to ${DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS}.`,
          ),
      })
      .strict(),
  ).refine(
    (value) => (value.resources !== undefined) !== (value.restore !== undefined),
    "Specify exactly one of resources or restore.",
  ),
  (jsonSchema) => {
    // Exactly-one(resources, restore) expressed with if/then/else rather than a
    // top-level oneOf/allOf: MCP clients (and the schema.integration test) reject
    // tool input schemas whose OUTERMOST schema is a bare combinator. if/then/else
    // are ordinary keywords at the root, so this is allowed there.
    jsonSchema.if = { required: ["resources"] };
    jsonSchema.then = { not: { required: ["restore"] } };
    jsonSchema.else = { required: ["restore"] };
  },
);
