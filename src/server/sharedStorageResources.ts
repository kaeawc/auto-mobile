import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";
import {
  SHARED_STORAGE_RESOURCE_TEMPLATES,
  buildSharedStorageResourceUri,
  parseSharedStorageResourceParams,
} from "./sharedStorageResourceContract";
import type { SharedStorageReadService } from "./sharedStorageReadService";

type SharedStorageReadServiceResolver = () => Promise<SharedStorageReadService>;

async function getDefaultSharedStorageReadService(): Promise<SharedStorageReadService> {
  const { getSharedStorageReadService } = await import("./sharedStorageReadService");
  return getSharedStorageReadService();
}

function createListNamespaceResource(service: SharedStorageReadServiceResolver) {
  return async (params: Record<string, string>): Promise<ResourceContent> => {
    const parts = parseSharedStorageResourceParams(params);
    const listing = await (
      await service()
    ).list({
      deviceId: parts.deviceId,
      namespace: parts.namespace,
    });
    return {
      uri: buildSharedStorageResourceUri({ deviceId: parts.deviceId, namespace: parts.namespace }),
      mimeType: "application/json",
      text: JSON.stringify(listing, null, 2),
    };
  };
}

function createReadFileResource(service: SharedStorageReadServiceResolver) {
  return async (params: Record<string, string>): Promise<ResourceContent> => {
    const parts = parseSharedStorageResourceParams(params);
    if (parts.path === undefined) {
      throw new Error("Shared-storage file resource path is required.");
    }

    const result = await (
      await service()
    ).read({
      deviceId: parts.deviceId,
      namespace: parts.namespace,
      path: parts.path,
    });
    const uri = buildSharedStorageResourceUri({
      deviceId: parts.deviceId,
      namespace: parts.namespace,
      path: parts.path,
    });

    // A completed read returns the file's bytes with its content type; any other
    // observation (missing/unavailable/unsupported) is a typed JSON envelope so
    // the client can distinguish "no such file" from an empty file.
    if (result.observation !== "complete") {
      return { uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) };
    }
    return {
      uri,
      mimeType: result.mimeType ?? "application/octet-stream",
      ...(result.text !== undefined ? { text: result.text } : { blob: result.blob ?? "" }),
    };
  };
}

export function registerSharedStorageResources(service?: SharedStorageReadService): void {
  const resolver: SharedStorageReadServiceResolver = service
    ? async () => service
    : getDefaultSharedStorageReadService;

  ResourceRegistry.registerTemplate(
    SHARED_STORAGE_RESOURCE_TEMPLATES.NAMESPACE,
    "Downloads Namespace Files",
    "List files staged into one bounded, user-visible Android Downloads namespace, " +
      "with normalized relative paths, byte counts, MIME types, and SHA-256 verification hashes.",
    "application/json",
    createListNamespaceResource(resolver),
  );

  ResourceRegistry.registerTemplate(
    SHARED_STORAGE_RESOURCE_TEMPLATES.FILE,
    "Downloads Namespace File",
    "Read one file from a bounded Android Downloads namespace. UTF-8 content is returned " +
      "as text; binary content is returned as a base64 MCP blob.",
    "application/octet-stream",
    createReadFileResource(resolver),
  );
}
