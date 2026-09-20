import {
  getSessionToolSelectionService,
  type SessionToolSelectionService,
} from "../features/toolSelection/SessionToolSelectionService";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";
import { ToolRegistry } from "./toolRegistry";

export const TOOL_CATALOG_RESOURCE_URI = "automobile:tools";

export interface ToolCatalogEntry {
  name: string;
  enabledWithoutSession: boolean;
  requiresDeviceSession: boolean;
}

export interface ToolCatalogResourceContent {
  lastUpdated: string;
  tools: ToolCatalogEntry[];
}

export interface ToolCatalogResourceDependencies {
  now: () => Date;
  sessionToolSelectionService: Pick<SessionToolSelectionService, "isEnabled">;
}

function timestamp(now: () => Date): string {
  try {
    return now().toISOString();
  } catch (error) {
    logger.warn(`[ToolCatalogResource] clock failed: ${errorMessage(error)}`, error);
    return "1970-01-01T00:00:00.000Z";
  }
}

export function createToolCatalogResourceHandler(
  overrides: Partial<ToolCatalogResourceDependencies> = {},
): () => Promise<ResourceContent> {
  // Resolve the singleton only when a production handler is created, after all
  // tools have registered. Tests inject this narrow dependency and never touch it.
  const dependencies: ToolCatalogResourceDependencies = {
    now: overrides.now ?? (() => new Date()),
    sessionToolSelectionService:
      overrides.sessionToolSelectionService ?? getSessionToolSelectionService(),
  };

  return async () => {
    const lastUpdated = timestamp(dependencies.now);
    try {
      const tools = await Promise.all(
        ToolRegistry.getAllTools()
          .filter((tool) => ToolRegistry.isUserConfigurableTool(tool.name))
          .map(async (tool) => {
            const enabledWithoutSession = await dependencies.sessionToolSelectionService.isEnabled(
              undefined,
              tool.name,
              tool.defaultEnabled,
            );
            return {
              name: tool.name,
              enabledWithoutSession,
              requiresDeviceSession: !enabledWithoutSession,
            };
          }),
      );
      tools.sort((left, right) => left.name.localeCompare(right.name));
      const content: ToolCatalogResourceContent = { lastUpdated, tools };
      return {
        uri: TOOL_CATALOG_RESOURCE_URI,
        mimeType: "application/json",
        text: JSON.stringify(content),
      };
    } catch (error) {
      logger.warn(`[ToolCatalogResource] resource read failed: ${errorMessage(error)}`, error);
      return {
        uri: TOOL_CATALOG_RESOURCE_URI,
        mimeType: "application/json",
        text: JSON.stringify({ lastUpdated, tools: [] } satisfies ToolCatalogResourceContent),
      };
    }
  };
}

export function registerToolCatalogResources(): void {
  ResourceRegistry.register(
    TOOL_CATALOG_RESOURCE_URI,
    "Tool Catalog",
    "Every registered AutoMobile tool with its default enabled/gated state, discoverable without acquiring a device.",
    "application/json",
    createToolCatalogResourceHandler(),
  );
}
