import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError } from "../models/ActionableError";
import { createJSONToolResponse } from "../utils/toolUtils";
import { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import { FEATURE_FLAG_DEFINITIONS, type FeatureFlagKey } from "../features/featureFlags/FeatureFlagDefinitions";

const featureFlagKeys = FEATURE_FLAG_DEFINITIONS.map(definition => definition.key) as [
  FeatureFlagKey,
  ...FeatureFlagKey[],
];

export const listFeatureFlagsSchema = z.object({});

export const setFeatureFlagSchema = z.object({
  key: z.enum(featureFlagKeys).describe("Flag key"),
  enabled: z.boolean().describe("Flag state"),
  config: z.record(z.any()).optional().describe("Flag config"),
});

export function registerFeatureFlagTools(): void {
  // Feature flag tools have been removed - feature flags should be managed
  // internally via configuration, not exposed as MCP tool calls
}
