import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";
import {
  APP_FILE_RESOURCE_TEMPLATES,
  buildAppFileResourceUri,
  parseAppFileResourceParams,
} from "./appFileContract";
import type { AppFileService } from "./appFileService";

type AppFileServiceResolver = () => Promise<AppFileService>;

async function getDefaultAppFileService(): Promise<AppFileService> {
  const { getAppFileService } = await import("./appFileService");
  return getAppFileService();
}

function createListAppFilesResource(service: AppFileServiceResolver) {
  return async (params: Record<string, string>): Promise<ResourceContent> => {
    const request = parseAppFileResourceParams(params);
    const result = await (await service()).listFiles({
      deviceId: request.deviceId,
      appId: request.appId,
      container: request.container,
    });
    return {
      uri: buildAppFileResourceUri(request),
      mimeType: "application/json",
      text: JSON.stringify(result, null, 2),
    };
  };
}

function createReadAppFileResource(service: AppFileServiceResolver) {
  return async (params: Record<string, string>): Promise<ResourceContent> => {
    const request = parseAppFileResourceParams(params);
    if (request.path === undefined) {
      throw new Error("App file resource path is required.");
    }

    const result = await (await service()).readFile({
      deviceId: request.deviceId,
      appId: request.appId,
      container: request.container,
      path: request.path,
    });

    return {
      uri: buildAppFileResourceUri(request),
      mimeType: result.mimeType,
      ...(result.text !== undefined ? { text: result.text } : { blob: result.blob ?? "" }),
    };
  };
}

export function registerAppFileResources(appFileService?: AppFileService): void {
  const service: AppFileServiceResolver = appFileService
    ? async () => appFileService
    : getDefaultAppFileService;

  ResourceRegistry.registerTemplate(
    APP_FILE_RESOURCE_TEMPLATES.CONTAINER,
    "App Container Files",
    "List files in a logical app container for a specific device and app.",
    "application/json",
    createListAppFilesResource(service)
  );

  ResourceRegistry.registerTemplate(
    APP_FILE_RESOURCE_TEMPLATES.FILE,
    "App Container File",
    "Read a file from a logical app container. UTF-8 content is returned as text; binary content is returned as a base64 MCP blob.",
    "application/octet-stream",
    createReadAppFileResource(service)
  );
}
