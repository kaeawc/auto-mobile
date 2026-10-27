import { prototypeShaderUses } from "./prototypeShaders";
import { isPrototypeMediaId } from "./prototypeMediaItems";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

const REPEAT_PLACEHOLDER = /\{[^{}]+\}/;

function addImage(value: unknown, ids: Set<string>): void {
  if (typeof value === "string") {
    // A `media:` id is minted on the device: never a host upload, never reported missing (#14192).
    // A repeat placeholder ("{item.thumbnail}") is a template, not an id, until the row is bound.
    if (!isPrototypeMediaId(value) && !REPEAT_PLACEHOLDER.test(value)) {
      ids.add(value);
    }
  } else {
    const pair = record(value);
    if (pair) {
      addImage(pair.light, ids);
      addImage(pair.dark, ids);
    }
  }
}
function addFont(style: unknown, fonts: Set<string>): void {
  const asset = record(record(style)?.fontFamily)?.asset;
  if (typeof asset === "string") {
    fonts.add(asset);
  }
}
/** Authored node slots, including components, themed images, rich text and conditional styles.
 * Opaque data/state/request bodies are not asset references even if their keys are named asset.
 */
export function collectPrototypeAssetReferences(spec: unknown): {
  images: Set<string>;
  fonts: Set<string>;
  shaders: Set<string>;
} {
  const images = new Set<string>();
  const fonts = new Set<string>();
  const shaders = new Set(
    prototypeShaderUses(spec)
      .map(({ shader }) => shader.asset)
      .filter((asset): asset is string => typeof asset === "string"),
  );
  walkPrototypeNodes(spec, (node) => {
    if (node.type === "image") {
      addImage(node.asset, images);
    }
    for (const item of Array.isArray(node.items) ? node.items : []) {
      addImage(record(item)?.image, images);
    }
    addFont(node.style, fonts);
    for (const entry of Array.isArray(node.styleWhen) ? node.styleWhen : []) {
      addFont(record(entry)?.style, fonts);
    }
    for (const span of Array.isArray(node.spans) ? node.spans : []) {
      addFont(record(span)?.style, fonts);
    }
  });
  return { images, fonts, shaders };
}
/** Saved-layout mirroring also preserves cached IDs found in opaque JSON for dynamic uses. */
export function collectPrototypeStrings(
  value: unknown,
  strings: Set<string>,
  references: Set<string>,
): void {
  const pending = [value];
  while (pending.length) {
    const child = pending.pop();
    if (typeof child === "string") {
      strings.add(child);
    } else if (child !== null && typeof child === "object") {
      pending.push(...Object.values(child));
    }
  }
  const { images, fonts, shaders } = collectPrototypeAssetReferences(value);
  for (const id of [...images, ...fonts, ...shaders]) {
    references.add(id);
  }
}
