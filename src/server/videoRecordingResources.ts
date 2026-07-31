import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import {
  getLatestVideoRecordingMetadata,
  getVideoRecordingMetadata,
  listVideoRecordings,
} from "./videoRecordingManager";
import { buildVideoArchiveItemUri, VIDEO_RESOURCE_URIS } from "./videoRecordingResourceUris";
import { logger } from "../utils/logger";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { VideoRecordingMetadata } from "../models";

/**
 * Absolute root every archived recording must live under. A DB row's
 * `file_path` is resolved against this and rejected if it escapes — closing the
 * arbitrary-file-read + base64-exfil vector where a poisoned/absolute
 * `file_path` would otherwise be read straight off disk (issue #4752, the
 * defense-in-depth confinement item). Mirrors `VideoRecorderService`'s archive
 * root so a legitimately-stored recording always resolves inside it.
 */
export const DEFAULT_VIDEO_ARCHIVE_ROOT = path.join(
  os.homedir(),
  ".auto-mobile",
  "video-archive"
);

/**
 * Resolve a stored file path and assert it is contained within `archiveRoot`.
 * Throws when the path escapes the archive (absolute path outside the root,
 * `..` traversal, or a symlink-style sibling), so the read never reaches
 * arbitrary files. Returns the resolved, confined absolute path.
 */
export function assertWithinArchiveRoot(filePath: string, archiveRoot: string): string {
  const resolvedRoot = path.resolve(archiveRoot);
  const resolved = path.resolve(resolvedRoot, filePath);
  const relative = path.relative(resolvedRoot, resolved);
  const escapes =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (escapes) {
    throw new Error(
      `Refusing to read recording file outside the archive root: ${filePath}`
    );
  }
  return resolved;
}

/**
 * The data-store surface the resource handlers depend on. Injecting it keeps the
 * handlers unit-testable without resolving the real file-backed video-recording
 * database (issue #3067) or touching the real filesystem.
 */
export interface VideoRecordingResourceStore {
  getLatest(scope?: { ownerSessionUuid?: string }): Promise<VideoRecordingMetadata | null>;
  getById(
    recordingId: string,
    options?: { touch?: boolean; ownerSessionUuid?: string }
  ): Promise<VideoRecordingMetadata | null>;
  list(scope?: { ownerSessionUuid?: string }): Promise<VideoRecordingMetadata[]>;
  readFile(filePath: string): Promise<Buffer>;
  /** Root every recording file must be confined to before it is read. */
  archiveRoot: string;
}

const defaultVideoRecordingResourceStore: VideoRecordingResourceStore = {
  getLatest: getLatestVideoRecordingMetadata,
  getById: getVideoRecordingMetadata,
  list: listVideoRecordings,
  readFile: fs.readFile,
  archiveRoot: DEFAULT_VIDEO_ARCHIVE_ROOT,
};

function getVideoMimeType(metadata: VideoRecordingMetadata): string {
  if (metadata.format === "mp4") {
    return "video/mp4";
  }
  return "application/octet-stream";
}

export async function buildVideoResourceContent(
  metadata: VideoRecordingMetadata,
  uri: string,
  store: VideoRecordingResourceStore = defaultVideoRecordingResourceStore
): Promise<ResourceContent> {
  if (!metadata.filePath) {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Missing file path for recording ${metadata.recordingId}`,
        metadata,
      }, null, 2),
    };
  }

  try {
    // Confine the read to the archive root before touching disk: a poisoned or
    // absolute `file_path` must not turn this resource into an arbitrary-file
    // read + base64 exfil (issue #4752).
    const confinedPath = assertWithinArchiveRoot(metadata.filePath, store.archiveRoot);
    const fileBuffer = await store.readFile(confinedPath);
    const blob = fileBuffer.toString("base64");
    return {
      uri,
      mimeType: getVideoMimeType(metadata),
      text: JSON.stringify({ metadata }, null, 2),
      blob,
    };
  } catch (error) {
    logger.error(`[VideoRecordingResources] Failed to read video ${metadata.recordingId}: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to read video data: ${error}`,
        metadata,
      }, null, 2),
    };
  }
}

export async function getLatestVideoRecording(
  store: VideoRecordingResourceStore = defaultVideoRecordingResourceStore
): Promise<ResourceContent> {
  try {
    const latest = await store.getLatest();
    if (!latest) {
      return {
        uri: VIDEO_RESOURCE_URIS.LATEST,
        mimeType: "application/json",
        text: JSON.stringify({
          error: "No video recordings available. Call videoRecording with action \"start\" first.",
        }, null, 2),
      };
    }

    const metadata = await store.getById(latest.recordingId, { touch: true }) ?? latest;
    return buildVideoResourceContent(metadata, VIDEO_RESOURCE_URIS.LATEST, store);
  } catch (error) {
    logger.error(`[VideoRecordingResources] Failed to get latest recording: ${error}`);
    return {
      uri: VIDEO_RESOURCE_URIS.LATEST,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to retrieve latest recording: ${error}`,
      }, null, 2),
    };
  }
}

export async function getVideoArchiveList(
  store: VideoRecordingResourceStore = defaultVideoRecordingResourceStore
): Promise<ResourceContent> {
  try {
    const recordings = await store.list();
    return {
      uri: VIDEO_RESOURCE_URIS.ARCHIVE,
      mimeType: "application/json",
      text: JSON.stringify({
        recordings,
        count: recordings.length,
      }, null, 2),
    };
  } catch (error) {
    logger.error(`[VideoRecordingResources] Failed to list recordings: ${error}`);
    return {
      uri: VIDEO_RESOURCE_URIS.ARCHIVE,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to list recordings: ${error}`,
      }, null, 2),
    };
  }
}

export async function getVideoArchiveItem(
  params: Record<string, string>,
  store: VideoRecordingResourceStore = defaultVideoRecordingResourceStore
): Promise<ResourceContent> {
  try {
    const recordingId = params.recordingId;
    if (!recordingId) {
      return {
        uri: VIDEO_RESOURCE_URIS.ARCHIVE_ITEM,
        mimeType: "application/json",
        text: JSON.stringify({ error: "Recording ID is required." }, null, 2),
      };
    }

    const metadata = await store.getById(recordingId, { touch: true });
    if (!metadata) {
      return {
        uri: buildVideoArchiveItemUri(recordingId),
        mimeType: "application/json",
        text: JSON.stringify({
          error: `Recording not found: ${recordingId}`,
        }, null, 2),
      };
    }

    return buildVideoResourceContent(metadata, buildVideoArchiveItemUri(recordingId), store);
  } catch (error) {
    logger.error(`[VideoRecordingResources] Failed to read recording: ${error}`);
    return {
      uri: VIDEO_RESOURCE_URIS.ARCHIVE_ITEM,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to retrieve recording: ${error}`,
      }, null, 2),
    };
  }
}

export function registerVideoRecordingResources(): void {
  ResourceRegistry.register(
    VIDEO_RESOURCE_URIS.LATEST,
    "Latest Video Recording",
    "The most recent video recording with metadata and base64-encoded video data.",
    "video/mp4",
    getLatestVideoRecording
  );

  ResourceRegistry.register(
    VIDEO_RESOURCE_URIS.ARCHIVE,
    "Video Recording Archive",
    "Metadata list for archived video recordings.",
    "application/json",
    getVideoArchiveList
  );

  ResourceRegistry.registerTemplate(
    VIDEO_RESOURCE_URIS.ARCHIVE_ITEM,
    "Video Recording",
    "Video recording content and metadata for the specified recording ID.",
    "video/mp4",
    getVideoArchiveItem
  );

  logger.info("[VideoRecordingResources] Registered video recording resources");
}
