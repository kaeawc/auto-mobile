import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";
import {
  APP_FILE_RESOURCE_TEMPLATES,
  buildAppFileResourceUri,
  parseAppFileResourceParams,
} from "./appFileContract";
import { getAppFileService } from "./appFileService";

async function listAppFilesResource(params: Record<string, string>): Promise<ResourceContent> {
  const request = parseAppFileResourceParams(params);
  const result = await getAppFileService().listFiles({
    deviceId: request.deviceId,
    appId: request.appId,
    container: request.container,
  });
  return {
    uri: buildAppFileResourceUri(request),
    mimeType: "application/json",
    text: JSON.stringify(result, null, 2),
  };
}

async function readAppFileResource(params: Record<string, string>): Promise<ResourceContent> {
  const request = parseAppFileResourceParams(params);
  if (request.path === undefined) {
    throw new Error("App file resource path is required.");
  }

  const result = await getAppFileService().readFile({
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
}

export function registerAppFileResources(): void {
  ResourceRegistry.registerTemplate(
    APP_FILE_RESOURCE_TEMPLATES.CONTAINER,
    "App Container Files",
    "List files in a logical app container for a specific device and app.",
    "application/json",
    listAppFilesResource
  );

  ResourceRegistry.registerTemplate(
    APP_FILE_RESOURCE_TEMPLATES.FILE,
    "App Container File",
    "Read a file from a logical app container. UTF-8 content is returned as text; binary content is returned as a base64 MCP blob.",
    "application/octet-stream",
    readAppFileResource
  );
}
