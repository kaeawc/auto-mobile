import {
  PROTOTYPE_GUIDE_URI,
  PROTOTYPE_ICONS_URI,
  renderPrototypeGuide,
  searchIcons,
} from "../features/prototype/prototypeGuide";
import {
  readNativePrototype,
  readNativePrototypeAsset,
  type NativePrototypeSources,
} from "../features/prototype/nativePrototype";
import {
  PROTOTYPE_EJECT_URI,
  PROTOTYPE_NATIVE_ASSET_URI,
  PROTOTYPE_NATIVE_URI,
} from "../features/prototype/nativePrototypeUris";
import { readPrototypeEject } from "../features/prototype/prototypeEject";
import {
  prototypeResourceUri,
  type PrototypeResourceFormat,
} from "../features/prototype/prototypeWebUris";
import {
  readPrototypeSourceResource,
  type PrototypeSourceFormat,
  type PrototypeSourceResourceQuery,
} from "../features/prototype/prototypeSourceResource";
import {
  prototypeVariantIds,
  readPrototypeWebResource,
  type PrototypeWebResourceQuery,
} from "../features/prototype/web/prototypeWebResource";
import {
  SharpPrototypeWebImageEncoder,
  type PrototypeWebImageEncoder,
} from "../features/prototype/web/webImageEncoding";
import {
  readPrototypeEmbedResource,
  type PrototypeEmbedResourceQuery,
} from "../features/prototype/web/prototypeEmbedResource";
import { encodeUriSegment } from "../utils/encodeUriSegment";
import type { PrototypeWebSources } from "./prototypeResources";
import type { ResourceContent } from "./resourceRegistry";

/**
 * How the prototype resources are read (#17709). `prototypeResources.ts` registers every URI and
 * template at startup and imports this module, with the guide, renderers and templates behind it,
 * on the first read.
 */
export { prototypeVariantIds };

/** The web page's image encoder (sharp). */
export function createPrototypeWebImageEncoder(): PrototypeWebImageEncoder {
  return new SharpPrototypeWebImageEncoder();
}

/** The read URI: the parameter-free one plus the given parameters in a stable order. */
function readUri(
  id: string,
  format: PrototypeResourceFormat,
  params: Record<string, string | undefined>,
): string {
  const query = new URLSearchParams(
    Object.entries(params)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  ).toString();
  const uri = prototypeResourceUri(id, format);
  return query ? `${uri}?${query}` : uri;
}

export async function readWeb(
  sources: PrototypeWebSources,
  query: PrototypeWebResourceQuery,
): Promise<ResourceContent> {
  const web = await readPrototypeWebResource(
    sources.revisions,
    query,
    sources.rendererVersion(),
    sources.images,
  );
  const { frame, revision, variant, mcpSessionId } = query;
  return {
    uri: readUri(query.id, "web", { frame, revision, variant, mcpSessionId }),
    mimeType: "text/html",
    text: web.html,
    _meta: { ...web.meta },
  };
}

export function readEmbed(
  sources: PrototypeWebSources,
  query: PrototypeEmbedResourceQuery,
): ResourceContent {
  const embed = readPrototypeEmbedResource(sources.revisions, query, sources.rendererVersion());
  const { revision, variant, mcpSessionId } = query;
  return {
    uri: readUri(query.id, "embed", { revision, variant, mcpSessionId }),
    mimeType: "application/json",
    text: embed.text,
    _meta: { ...embed.meta },
  };
}

export function readSource(
  sources: PrototypeWebSources,
  format: PrototypeSourceFormat,
  query: PrototypeSourceResourceQuery,
): ResourceContent {
  const file = readPrototypeSourceResource(
    sources.revisions,
    format,
    query,
    sources.rendererVersion(),
  );
  const { frame, revision, mcpSessionId } = query;
  return {
    uri: readUri(query.id, format, { frame, revision, mcpSessionId }),
    mimeType: file.mimeType,
    text: file.text,
    _meta: { ...file.meta },
  };
}

export function readGuide(): ResourceContent {
  return { uri: PROTOTYPE_GUIDE_URI, mimeType: "text/markdown", text: renderPrototypeGuide() };
}

export function readIcons(query: string): ResourceContent {
  const { total, names } = searchIcons(query);
  return {
    uri: `${PROTOTYPE_ICONS_URI}?query=${encodeUriSegment(query)}`,
    mimeType: "application/json",
    text: JSON.stringify({ query, total, truncated: total > names.length, names }),
  };
}

export async function readNative(
  params: Record<string, string>,
  sources: NativePrototypeSources,
): Promise<ResourceContent> {
  const native = await readNativePrototype(params, sources);
  const query = new URLSearchParams(params).toString();
  return {
    uri: query ? `${PROTOTYPE_NATIVE_URI}?${query}` : PROTOTYPE_NATIVE_URI,
    mimeType: "application/json",
    text: JSON.stringify(native, null, 2),
  };
}

export async function readEject(
  params: Record<string, string>,
  sources: NativePrototypeSources,
): Promise<ResourceContent> {
  const ejected = await readPrototypeEject(params, sources);
  const query = new URLSearchParams(params).toString();
  return {
    uri: query ? `${PROTOTYPE_EJECT_URI}?${query}` : PROTOTYPE_EJECT_URI,
    mimeType: "application/json",
    text: JSON.stringify(ejected, null, 2),
  };
}

export async function readNativeAsset(
  params: Record<string, string>,
  sources: NativePrototypeSources,
): Promise<ResourceContent> {
  const asset = await readNativePrototypeAsset(params, sources);
  return {
    uri: `${PROTOTYPE_NATIVE_ASSET_URI}?${new URLSearchParams(params).toString()}`,
    mimeType: asset.mimeType,
    blob: Buffer.from(asset.bytes).toString("base64"),
  };
}
