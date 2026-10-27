import { PROTOTYPE_MEDIA_ITEMS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

/**
 * Device-local media items (#14192). Producers (camera, picker, recorder) write a media item
 * object, or an array of them, to an `into` pointer in `/data`; the device mints its ids with the
 * reserved `media:` prefix and keeps the bytes in a per-session store. An `image` shows one through
 * `asset: {data: "/pointer"}` (a pointer to a string id), or through a repeat placeholder in a string
 * `asset`. The contract here is the spec language only: `imageAsset.data`, the reserved prefix and
 * the store limits. The device stores, the `media` host action and `mediaItems.inject` follow.
 *
 * Media item shape (written by producers, never validated as spec input): `asset` (the id),
 * `kind` image|video|audio, `mimeType`, optional `width`, `height`, `bytes`, `durationMs` (video and
 * audio), `name`, `source` camera|library|microphone|injected, `createdAt` (ISO 8601) and
 * `thumbnail` (an id of a derived JPEG of at most 512 px). Absent fields are omitted, never null.
 */

/** Ids minted on the device start with this; host asset ids may not. */
export const PROTOTYPE_MEDIA_ID_PREFIX = "media:";

export function isPrototypeMediaId(id: string): boolean {
  return id.startsWith(PROTOTYPE_MEDIA_ID_PREFIX);
}

/** Authored paths of every `imageAsset` that binds a data pointer, in tree order. */
export function prototypeMediaItemFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (record(node.asset)?.data !== undefined && node.type === "image") {
      fields.push(`${path}.asset.data`);
    }
    const items = Array.isArray(node.items) ? node.items : [];
    items.forEach((item, index) => {
      if (record(record(item)?.image)?.data !== undefined) {
        fields.push(`${path}.items[${index}].image.data`);
      }
    });
  });
  return fields;
}

export function prototypeMediaItemsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_MEDIA_ITEMS_CAPABILITY}, so it cannot resolve the device media item bound at ${fields[0]}${more}. Nothing was shown. ${update}, or use an uploaded asset id.`;
}
