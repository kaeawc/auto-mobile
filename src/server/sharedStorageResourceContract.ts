import {
  normalizeSharedStorageNamespace,
  normalizeSharedStorageRelativePath,
} from "./sharedStorageContract";

/**
 * Read-only MCP resources for files staged into a bounded, user-visible
 * Downloads namespace (the read counterpart of putAppFile with target.domain user_files).
 * The namespace-list resource enumerates normalized relative paths with bounded
 * verification metadata; the file resource returns UTF-8 text or a binary blob.
 */
export const SHARED_STORAGE_RESOURCE_TEMPLATES = {
  NAMESPACE: "automobile:devices/{deviceId}/downloads/{namespace}",
  FILE: "automobile:devices/{deviceId}/downloads/{namespace}/{path}",
} as const;

export const CANONICAL_USER_FILES_RESOURCE_TEMPLATES = {
  NAMESPACE: "automobile:devices/{deviceId}/storage-domains/user_files/{namespace}",
  FILE: "automobile:devices/{deviceId}/storage-domains/user_files/{namespace}/{path}",
} as const;

export const CANONICAL_MEDIA_LIBRARY_RESOURCE_TEMPLATES = {
  NAMESPACE: "automobile:devices/{deviceId}/storage-domains/media_library/{namespace}",
  FILE: "automobile:devices/{deviceId}/storage-domains/media_library/{namespace}/{path}",
} as const;

export function buildCanonicalMediaLibraryResourceUri(parts: SharedStorageResourceParts): string {
  return buildCanonicalUserFilesResourceUri(parts).replace(
    "/storage-domains/user_files/",
    "/storage-domains/media_library/",
  );
}

/** How completely a namespace or file could be observed on the device. */
export type SharedStorageObservation = "complete" | "missing" | "unavailable" | "unsupported";

export interface SharedStorageResourceParts {
  deviceId: string;
  namespace: string;
  path?: string;
}

export interface SharedStorageFileEntry {
  path: string;
  name: string;
  byteCount?: number;
  mimeType?: string;
  sha256?: string;
  sha256Unavailable?: string;
  lastModified?: string;
  resourceUri: string;
}

export interface SharedStorageNamespaceListing {
  deviceId: string;
  platform: string;
  namespace: string;
  userId?: number;
  userSource?: string;
  downloadsDirectory?: string;
  observation: SharedStorageObservation;
  reason?: string;
  files: SharedStorageFileEntry[];
}

export interface SharedStorageFileReadResult {
  deviceId: string;
  platform: string;
  namespace: string;
  path: string;
  userId?: number;
  observation: SharedStorageObservation;
  reason?: string;
  byteCount?: number;
  mimeType?: string;
  sha256?: string;
  text?: string;
  blob?: string;
  resourceUri: string;
}

function encodePathSegments(path: string): string {
  return normalizeSharedStorageRelativePath(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function buildSharedStorageResourceUri(parts: SharedStorageResourceParts): string {
  return buildUserFilesUri(parts, false);
}

export function buildCanonicalUserFilesResourceUri(parts: SharedStorageResourceParts): string {
  return buildUserFilesUri(parts, true);
}

function buildUserFilesUri(parts: SharedStorageResourceParts, canonical: boolean): string {
  const namespace = normalizeSharedStorageNamespace(parts.namespace);
  const base =
    `automobile:devices/${encodeURIComponent(parts.deviceId)}` +
    `/${canonical ? "storage-domains/user_files" : "downloads"}/${encodeURIComponent(namespace)}`;
  return parts.path === undefined ? base : `${base}/${encodePathSegments(parts.path)}`;
}

export function parseSharedStorageResourceParams(
  params: Record<string, string>,
): SharedStorageResourceParts {
  const namespace = normalizeSharedStorageNamespace(decodeURIComponent(params.namespace));
  return {
    deviceId: decodeURIComponent(params.deviceId),
    namespace,
    ...(params.path !== undefined
      ? { path: normalizeSharedStorageRelativePath(decodeURIComponent(params.path)) }
      : {}),
  };
}
