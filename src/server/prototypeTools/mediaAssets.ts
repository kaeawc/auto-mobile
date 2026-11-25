/**
 * Media assets by path on the `prototype` tool (#14254): video, audio and WebVTT files listed in
 * `assets` are streamed with the chunked media upload instead of the single-frame image upload.
 * Only a show on Android CtrlProxy can receive them today; every other path refuses them before
 * anything is uploaded.
 */
import type {
  PrototypeAssetSource,
  UploadedPrototypeAsset,
} from "../../features/prototype/prototypeAssetUploader";
import { boundedPrototypeError } from "../../features/prototype/prototypeErrors";
import {
  type PrototypeMediaFileOpener,
  type PrototypeMediaTransportClient,
  prototypeMediaMimeTypeForPath,
  uploadPrototypeMediaAsset,
} from "../../features/prototype/prototypeMediaUpload";

export interface PrototypeMediaSource {
  id: string;
  path: string;
}

/** `assets` entries whose path names a media file, and the rest for the image and font path. */
export function splitPrototypeMediaSources(sources: readonly PrototypeAssetSource[]): {
  media: PrototypeMediaSource[];
  other: PrototypeAssetSource[];
} {
  const media: PrototypeMediaSource[] = [];
  const other: PrototypeAssetSource[] = [];
  for (const source of sources) {
    if (source.path !== undefined && prototypeMediaMimeTypeForPath(source.path) !== null) {
      media.push({ id: source.id, path: source.path });
    } else {
      other.push(source);
    }
  }
  return { media, other };
}

const IOS_UNPLAYABLE = /\.(?:webm|ogg)$/i;

/**
 * Why `media` cannot be uploaded on this call, or null when it can: only `show` uploads media, and
 * only through a transport that implements the chunked upload (Android CtrlProxy).
 */
export function prototypeMediaRefusal(
  media: readonly PrototypeMediaSource[],
  action: string,
  client: PrototypeMediaTransportClient | undefined,
  /** The target is the iOS agent, whose AVPlayer cannot decode WebM or Ogg. */
  ios: boolean,
): string | null {
  if (media.length === 0) {
    return null;
  }
  const ids = media.map((source) => `'${source.id}'`).join(", ");
  if (action !== "show") {
    return boundedPrototypeError(
      `Media assets (${ids}) can only be sent with show for now: ${action} cannot carry video, audio or caption files. Remove them from assets, or show the prototype instead. No assets were uploaded and the prototype was not changed.`,
    );
  }
  if (client !== undefined) {
    return null;
  }
  const unplayable = media.filter((source) => IOS_UNPLAYABLE.test(source.path));
  const iosNote =
    ios && unplayable.length > 0
      ? ` On iOS, WebM and Ogg (${unplayable.map((source) => `'${source.id}'`).join(", ")}) would not play in any case: AVPlayer cannot decode them, so use MP4, M4A or MP3.`
      : "";
  return boundedPrototypeError(
    `This device's prototype runtime cannot receive media assets (${ids}) yet; only Android CtrlProxy accepts video, audio and caption files.${iosNote} No assets were uploaded and the prototype was not changed.`,
  );
}

/**
 * Uploads `media` one file at a time; the first failure stops the rest and reports what was
 * already uploaded, which stays on the device until the prototype session ends.
 */
export async function uploadPrototypeMediaSources(
  client: PrototypeMediaTransportClient,
  media: readonly PrototypeMediaSource[],
  options: { signal?: AbortSignal; opener?: PrototypeMediaFileOpener; uploaded: readonly string[] },
): Promise<{ uploaded: UploadedPrototypeAsset[]; error?: string }> {
  const uploaded: UploadedPrototypeAsset[] = [];
  for (const source of media) {
    const outcome = await uploadPrototypeMediaAsset(client, source, {
      signal: options.signal,
      opener: options.opener,
    });
    if (!outcome.success || outcome.mimeType === undefined || outcome.bytes === undefined) {
      const done = [...options.uploaded, ...uploaded.map((asset) => asset.id)];
      const already =
        done.length === 0
          ? "No assets were uploaded."
          : `Already uploaded: ${done.join(", ")}; they stay on the device until the prototype session ends, and re-sending the call replaces them.`;
      return {
        uploaded,
        error: boundedPrototypeError(
          `${outcome.error ?? `Prototype media asset '${source.id}' was not uploaded.`} ${already} The prototype was not changed.`,
        ),
      };
    }
    uploaded.push({ id: source.id, mimeType: outcome.mimeType, bytes: outcome.bytes });
  }
  return { uploaded };
}

/**
 * Streams `media` once the image and font uploads in `images` succeeded, and returns everything
 * stored; a failure of either reports what was already uploaded.
 */
export async function withPrototypeMediaUploads(
  client: PrototypeMediaTransportClient | undefined,
  media: readonly PrototypeMediaSource[],
  images: { success: boolean; uploaded: UploadedPrototypeAsset[]; error?: string },
  options: { signal?: AbortSignal; opener?: PrototypeMediaFileOpener },
): Promise<{ uploaded: UploadedPrototypeAsset[]; error?: string }> {
  if (!images.success || media.length === 0 || client === undefined) {
    return { uploaded: images.uploaded, ...(images.success ? {} : { error: images.error }) };
  }
  const streamed = await uploadPrototypeMediaSources(client, media, {
    ...options,
    uploaded: images.uploaded.map((asset) => asset.id),
  });
  return { ...streamed, uploaded: [...images.uploaded, ...streamed.uploaded] };
}
