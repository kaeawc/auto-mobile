import { z } from "zod/v4";
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

export const setDeviceResourcesSchema = addDeviceTargetingToSchema(
  z
    .object({
      resources: deviceResourceConfigurationSchema,
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
);
