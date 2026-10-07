import { ResourceRegistry, type ResourceContent } from "./resourceRegistry";
import {
  SHARED_STORAGE_RESOURCE_TEMPLATES,
  CANONICAL_USER_FILES_RESOURCE_TEMPLATES,
  CANONICAL_MEDIA_LIBRARY_RESOURCE_TEMPLATES,
  buildCanonicalMediaLibraryResourceUri,
  buildSharedStorageResourceUri,
  buildCanonicalUserFilesResourceUri,
  parseSharedStorageResourceParams,
} from "./sharedStorageResourceContract";
import type { SharedStorageReadService } from "./sharedStorageReadService";

type SharedStorageReadServiceResolver = () => Promise<SharedStorageReadService>;

async function getDefaultSharedStorageReadService(): Promise<SharedStorageReadService> {
  const { getSharedStorageReadService } = await import("./sharedStorageReadService");
  return getSharedStorageReadService();
}

function createListNamespaceResource(
  service: SharedStorageReadServiceResolver,
  buildUri: typeof buildSharedStorageResourceUri = buildSharedStorageResourceUri,
  domain: "user_files" | "media_library" = "user_files",
) {
  return async (params: Record<string, string>): Promise<ResourceContent> => {
    const parts = parseSharedStorageResourceParams(params);
    const listing = await (
      await service()
    ).list({
      deviceId: parts.deviceId,
      namespace: parts.namespace,
      domain,
    });
    return {
      uri: buildUri({ deviceId: parts.deviceId, namespace: parts.namespace }),
      mimeType: "application/json",
      text: JSON.stringify(
        {
          ...listing,
          files: listing.files.map((entry) => ({
            ...entry,
            resourceUri: buildUri({
              deviceId: parts.deviceId,
              namespace: parts.namespace,
              path: entry.path,
            }),
          })),
        },
        null,
        2,
      ),
    };
  };
}

function createReadFileResource(
  service: SharedStorageReadServiceResolver,
  buildUri: typeof buildSharedStorageResourceUri = buildSharedStorageResourceUri,
  domain: "user_files" | "media_library" = "user_files",
) {
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
      domain,
      path: parts.path,
    });
    const uri = buildUri({
      deviceId: parts.deviceId,
      namespace: parts.namespace,
      path: parts.path,
    });

    // A completed read returns the file's bytes with its content type; any other
    // observation (missing/unavailable/unsupported) is a typed JSON envelope so
    // the client can distinguish "no such file" from an empty file.
    if (result.observation !== "complete") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ ...result, resourceUri: uri }, null, 2),
      };
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

  for (const [templates, buildUri, domain] of [
    [CANONICAL_USER_FILES_RESOURCE_TEMPLATES, buildCanonicalUserFilesResourceUri, "user_files"],
    [
      CANONICAL_MEDIA_LIBRARY_RESOURCE_TEMPLATES,
      buildCanonicalMediaLibraryResourceUri,
      "media_library",
    ],
    [SHARED_STORAGE_RESOURCE_TEMPLATES, buildSharedStorageResourceUri, "user_files"],
  ] as const) {
    ResourceRegistry.registerTemplate(
      templates.NAMESPACE,
      domain === "media_library" ? "Media Library Namespace Files" : "Downloads Namespace Files",
      "List files staged by putAppFile into one bounded storage-domain namespace, " +
        "with normalized relative paths, byte counts, MIME types, and SHA-256 verification hashes.",
      "application/json",
      createListNamespaceResource(resolver, buildUri, domain),
    );

    ResourceRegistry.registerTemplate(
      templates.FILE,
      domain === "media_library" ? "Media Library Namespace File" : "Downloads Namespace File",
      "Read one file staged by putAppFile in a bounded storage-domain namespace. UTF-8 content is returned " +
        "as text; binary content is returned as a base64 MCP blob.",
      "application/octet-stream",
      createReadFileResource(resolver, buildUri, domain),
    );
  }
}
