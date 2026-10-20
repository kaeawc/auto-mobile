import { imageAssetSchema } from "../prototypePresentationSchemas";
import { walkPrototypeNodes } from "../prototypeNodeChildren";
import { record } from "../prototypeTemplate";

export interface BundleReferences {
  assets: Set<string>;
  fonts: Set<string>;
}
function imageIds(value: unknown, out: Set<string>): void {
  const parsed = imageAssetSchema.safeParse(value);
  if (!parsed.success) {
    return;
  }
  if (typeof parsed.data === "string") {
    out.add(parsed.data);
  } else {
    out.add(parsed.data.light);
    out.add(parsed.data.dark);
  }
}
function fontId(style: unknown, out: Set<string>): void {
  const id = record(record(style)?.fontFamily)?.asset;
  if (typeof id === "string") {
    out.add(id);
  }
}
/** Reuse the node walker and image schema; opaque data/action payloads are not references. */
export function bundleReferences(spec: unknown): BundleReferences {
  const out: BundleReferences = { assets: new Set(), fonts: new Set() };
  walkPrototypeNodes(spec, (node) => {
    if (node.type === "image") {
      imageIds(node.asset, out.assets);
    }
    fontId(node.style, out.fonts);
    for (const item of Array.isArray(node.items) ? node.items : []) {
      imageIds(record(item)?.image, out.assets);
    }
    for (const span of Array.isArray(node.spans) ? node.spans : []) {
      fontId(record(span)?.style, out.fonts);
    }
    for (const when of Array.isArray(node.styleWhen) ? node.styleWhen : []) {
      fontId(record(when)?.style, out.fonts);
    }
  });
  return out;
}
