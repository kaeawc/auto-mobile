import { pathToFileURL } from "url";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";

/** `simctl push` refuses payloads over 4 KiB, matching the APNs limit. */
export const SIMCTL_PUSH_PAYLOAD_LIMIT_BYTES = 4096;

/**
 * Custom top-level key carrying the requested image URL (#14097). A Notification Service
 * Extension in the app reads it (with `aps.mutable-content: 1`) to download and attach the image.
 */
export const IOS_PUSH_IMAGE_URL_KEY = "automobile-image-url";

const SIMULATOR_TARGET_BUNDLE_KEY = "Simulator Target Bundle";
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export interface IosPushPayloadOptions {
  title: string;
  body: string;
  imageType?: "normal" | "bigPicture";
  imagePath?: string;
  actions?: readonly unknown[];
  /** Legacy alias for `category`; `category` wins when both are set. */
  channelId?: string;
  category?: string;
  /** Raw APNs JSON; its keys (and `aps` fields) override the generated ones. */
  payload?: Record<string, unknown>;
}

export type IosPushPayloadBuild =
  | { ok: true; json: string; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A URL stays as given; a host path becomes a `file://` URL resolved like Android's imagePath. */
function toImageUrl(imagePath: string): string {
  if (URL_SCHEME_PATTERN.test(imagePath) && !/^[A-Za-z]:[\\/]/.test(imagePath)) {
    return imagePath;
  }
  return pathToFileURL(resolvePathFromDaemonLaunchWorkingDirectory(imagePath)).href;
}

function imageFields(
  options: IosPushPayloadOptions,
  warnings: string[],
): { aps: Record<string, unknown>; top: Record<string, unknown> } {
  if (!options.imagePath) {
    if (options.imageType === "bigPicture") {
      warnings.push("bigPicture needs imagePath; no image was sent.");
    }
    return { aps: {}, top: {} };
  }
  warnings.push(
    `The image is sent as "${IOS_PUSH_IMAGE_URL_KEY}" with mutable-content: 1; it is shown only if the app's Notification Service Extension downloads and attaches it.`,
  );
  return {
    aps: { "mutable-content": 1 },
    top: { [IOS_PUSH_IMAGE_URL_KEY]: toImageUrl(options.imagePath) },
  };
}

function actionWarning(options: IosPushPayloadOptions, category: string | undefined) {
  if (!options.actions || options.actions.length === 0) {
    return undefined;
  }
  return category
    ? "actions were ignored: iOS buttons come from the UNNotificationCategory the app registered for the category."
    : "action buttons require category naming a UNNotificationCategory the app registered; actions were ignored.";
}

/**
 * Assemble the `simctl push` JSON for an iOS Simulator notification (#14097). Generated fields
 * (alert, sound, category, mutable-content, image URL) come first; a raw `payload` then overrides
 * any of them, so callers can set `interruption-level`, `thread-id`, custom keys, and so on. The
 * target bundle key always names the bundle the push is sent to.
 */
export function buildIosPushPayload(
  options: IosPushPayloadOptions,
  bundleId: string,
): IosPushPayloadBuild {
  const warnings: string[] = [];
  const raw = options.payload ?? {};
  if (!isPlainObject(raw)) {
    return { ok: false, error: "payload must be a JSON object.", warnings };
  }
  if (raw.aps !== undefined && !isPlainObject(raw.aps)) {
    return { ok: false, error: "payload.aps must be a JSON object when provided.", warnings };
  }

  const category = options.category ?? options.channelId;
  const image = imageFields(options, warnings);
  const actions = actionWarning(options, category);
  if (actions) {
    warnings.push(actions);
  }

  const aps = {
    alert: { title: options.title, body: options.body },
    sound: "default",
    ...(category ? { category } : {}),
    ...image.aps,
    ...(raw.aps as Record<string, unknown> | undefined),
  };
  const json = JSON.stringify({
    ...image.top,
    ...raw,
    aps,
    [SIMULATOR_TARGET_BUNDLE_KEY]: bundleId,
  });
  if (Buffer.byteLength(json, "utf8") > SIMCTL_PUSH_PAYLOAD_LIMIT_BYTES) {
    return {
      ok: false,
      error: `APNs payload exceeds the ${SIMCTL_PUSH_PAYLOAD_LIMIT_BYTES}-byte simctl push limit.`,
      warnings,
    };
  }
  return { ok: true, json, warnings };
}
