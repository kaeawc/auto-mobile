import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { mapBindableFields, record } from "./prototypeTemplate";

function addImage(value: unknown, ids: Set<string>): void {
  if (typeof value === "string") {
    ids.add(value);
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
 * Upload file slots are assets; opaque data/state/literal bodies are not asset references.
 */
export function collectPrototypeAssetReferences(spec: unknown): {
  images: Set<string>;
  fonts: Set<string>;
} {
  const images = new Set<string>();
  const fonts = new Set<string>();
  walkPrototypeNodes(spec, (node, path) => {
    mapBindableFields(node, path, (value, _at, kind) => {
      if (kind === "request") {
        const body = record(record(value)?.body);
        const files = [
          body?.file,
          ...(Array.isArray(body?.multipart)
            ? body.multipart.map((part) => record(part)?.file)
            : []),
        ];
        for (const file of files) {
          const asset = record(file)?.asset;
          if (typeof asset === "string") {
            images.add(asset);
          }
        }
      }
      return value;
    });
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
  return { images, fonts };
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
  const { images, fonts } = collectPrototypeAssetReferences(value);
  for (const id of [...images, ...fonts]) {
    references.add(id);
  }
}
