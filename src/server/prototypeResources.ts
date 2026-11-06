import { ResourceRegistry } from "./resourceRegistry";
import {
  ICON_LOOKUP_LIMIT,
  PROTOTYPE_GUIDE_URI,
  PROTOTYPE_ICONS_TEMPLATE,
  PROTOTYPE_ICONS_URI,
  renderPrototypeGuide,
  searchIcons,
} from "../features/prototype/prototypeGuide";
import { encodeUriSegment } from "../utils/encodeUriSegment";
import {
  readNativePrototype,
  readNativePrototypeAsset,
  type NativePrototypeSources,
} from "../features/prototype/nativePrototype";
import {
  PROTOTYPE_EJECT_TEMPLATE,
  PROTOTYPE_EJECT_URI,
  PROTOTYPE_NATIVE_ASSET_TEMPLATE,
  PROTOTYPE_NATIVE_ASSET_URI,
  PROTOTYPE_NATIVE_TEMPLATE,
  PROTOTYPE_NATIVE_URI,
} from "../features/prototype/nativePrototypeUris";
import { readPrototypeEject } from "../features/prototype/prototypeEject";
import { defaultSavedPrototypeMirror } from "../features/prototype/savedPrototypeMirror";
import { getMcpServerVersion, releaseVersion } from "../utils/mcpVersion";
import {
  daemonPrototypeShownSpecs,
  daemonPrototypeSpecRevisions,
} from "./prototypeTools/registration";
import type {
  PrototypeSpecRevisionEvent,
  PrototypeSpecRevisionSource,
} from "../features/prototype/prototypeSpecRevisions";
import {
  PROTOTYPE_COMPOSE_TEMPLATE,
  PROTOTYPE_EMBED_TEMPLATE,
  PROTOTYPE_SWIFTUI_TEMPLATE,
  PROTOTYPE_WEB_TEMPLATE,
  prototypeResourceName,
  prototypeEmbedUri,
  prototypeResourceUri,
  prototypeWebUri,
  type PrototypeResourceFormat,
} from "../features/prototype/prototypeWebUris";
import {
  prototypeSourceMimeType,
  readPrototypeSourceResource,
  type PrototypeSourceFormat,
  type PrototypeSourceResourceQuery,
} from "../features/prototype/prototypeSourceResource";
import {
  prototypeVariantIds,
  readPrototypeWebResource,
  type PrototypeWebImageSources,
  type PrototypeWebResourceQuery,
} from "../features/prototype/web/prototypeWebResource";
import {
  SharpPrototypeWebImageEncoder,
  type PrototypeWebAssetSource,
} from "../features/prototype/web/webImageEncoding";
import {
  defaultPrototypeAssetCache,
  type PrototypeAssetCache,
} from "../features/prototype/prototypeAssetCache";
import {
  readPrototypeEmbedResource,
  type PrototypeEmbedResourceQuery,
} from "../features/prototype/web/prototypeEmbedResource";
import { logger } from "../utils/logger";
import { decodeSegmentOrThrow } from "./resourceUriSegments";
import type { ResourceContent } from "./resourceRegistry";

/** Live sources: the prototype tool's shown specs (and the platforms it showed on) and the saved mirror. */
export function defaultNativePrototypeSources(): NativePrototypeSources {
  return {
    shownSpec: (deviceId, id) =>
      daemonPrototypeShownSpecs()?.read(deviceId, id) ?? { kind: "unknown" },
    devicesShowing: (id) => daemonPrototypeShownSpecs()?.devicesShowing(id) ?? [],
    savedPrototypes: (deviceId) => defaultSavedPrototypeMirror().list(deviceId),
    platformOf: async (deviceId) => daemonPrototypeShownSpecs()?.platformOf(deviceId),
    libraryVersion: () => releaseVersion(getMcpServerVersion()),
  };
}

/** Where the per-id resources read spec revisions and the version stamped into their `_meta`. */
export interface PrototypeWebSources {
  readonly revisions: PrototypeSpecRevisionSource;
  readonly rendererVersion: () => string;
  /** Asset bytes and the encoder for the web page's images; without it images stay placeholders. */
  readonly images?: PrototypeWebImageSources;
}

/**
 * Asset bytes the host cached when it uploaded them to a device showing one of the variants
 * (Android caches uploads per device). Asset ids are chosen per device and the page holds one
 * image per id, so when two devices cached different bytes under the id, it stays a placeholder
 * rather than drawing one device's image in another's variant.
 */
export function cachedPrototypeWebAssets(
  devicesShowing: (id: string) => readonly string[],
  cache: Pick<PrototypeAssetCache, "get">,
): (variantIds: readonly string[]) => PrototypeWebAssetSource {
  return (variantIds) => ({
    get: async (assetId) => {
      const devices = [...new Set(variantIds.flatMap((id) => devicesShowing(id)))];
      let found: Awaited<ReturnType<PrototypeAssetCache["get"]>>;
      for (const device of devices) {
        const asset = await cache.get(device, assetId);
        if (!asset) {
          continue;
        }
        if (found && !Buffer.from(found.bytes).equals(Buffer.from(asset.bytes))) {
          logger.warn(
            `[PROTOTYPE] Devices showing ${variantIds.join(", ")} cached different bytes for asset ${assetId}; the web page keeps its placeholder.`,
          );
          return undefined;
        }
        found ??= asset;
      }
      return found;
    },
  });
}

export function defaultPrototypeWebSources(): PrototypeWebSources {
  return {
    revisions: daemonPrototypeSpecRevisions(),
    rendererVersion: () => releaseVersion(getMcpServerVersion()),
    images: {
      assets: cachedPrototypeWebAssets(
        (id) => daemonPrototypeShownSpecs()?.devicesShowing(id) ?? [],
        defaultPrototypeAssetCache(),
      ),
      encoder: new SharpPrototypeWebImageEncoder(),
    },
  };
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

async function readWeb(
  sources: PrototypeWebSources,
  query: PrototypeWebResourceQuery,
): Promise<ResourceContent> {
  const web = await readPrototypeWebResource(
    sources.revisions,
    query,
    sources.rendererVersion(),
    sources.images,
  );
  const { frame, revision, variant } = query;
  return {
    uri: readUri(query.id, "web", { frame, revision, variant }),
    mimeType: "text/html",
    text: web.html,
    _meta: { ...web.meta },
  };
}

function readEmbed(
  sources: PrototypeWebSources,
  query: PrototypeEmbedResourceQuery,
): ResourceContent {
  const embed = readPrototypeEmbedResource(sources.revisions, query, sources.rendererVersion());
  const { revision, variant } = query;
  return {
    uri: readUri(query.id, "embed", { revision, variant }),
    mimeType: "application/json",
    text: embed.text,
    _meta: { ...embed.meta },
  };
}

function readSource(
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
  const { frame, revision } = query;
  return {
    uri: readUri(query.id, format, { frame, revision }),
    mimeType: file.mimeType,
    text: file.text,
    _meta: { ...file.meta },
  };
}

/** One per-id format: how its concrete resource is listed and read. */
interface PerIdFormat {
  readonly format: PrototypeResourceFormat;
  readonly title: string;
  description(id: string): string;
  readonly mimeType: string;
  read(sources: PrototypeWebSources, id: string): ResourceContent | Promise<ResourceContent>;
}

const sourceFormat = (format: PrototypeSourceFormat, label: string): PerIdFormat => ({
  format,
  title: label,
  description: (id) =>
    `Prototype ${id} as one ${label} source file with the spec inlined (latest revision)`,
  mimeType: prototypeSourceMimeType(format),
  read: (sources, id) => readSource(sources, format, { id }),
});

const PER_ID_FORMATS: readonly PerIdFormat[] = [
  {
    format: "web",
    title: "web",
    description: (id) =>
      `Prototype ${id} as a self-contained HTML page in a device frame (latest revision)`,
    mimeType: "text/html",
    read: (sources, id) => readWeb(sources, { id }),
  },
  {
    format: "embed",
    title: "embed",
    description: (id) =>
      `Prototype ${id} as an embed envelope for the web library: its spec and required capabilities (latest revision)`,
    mimeType: "application/json",
    read: (sources, id) => readEmbed(sources, { id }),
  },
  sourceFormat("compose", "Compose"),
  sourceFormat("swiftui", "SwiftUI"),
];

/** Every format's parameter-free URI of an id. */
function perIdUris(id: string): string[] {
  return PER_ID_FORMATS.map(({ format }) => prototypeResourceUri(id, format));
}

/** Ids whose concrete resources this module registered, so stale ones can be unregistered. */
const listedWebIds = new Set<string>();
let unsubscribeWeb: (() => void) | undefined;
let webNotifications: Promise<void> = Promise.resolve();

/** Registers one parameter-free resource per known id and drops evicted ones; true if it changed. */
function syncWebResources(sources: PrototypeWebSources): boolean {
  const known = new Set(sources.revisions.ids());
  let changed = false;
  for (const id of listedWebIds) {
    if (!known.has(id)) {
      perIdUris(id).forEach((uri) => ResourceRegistry.unregister(uri));
      listedWebIds.delete(id);
      changed = true;
    }
  }
  for (const id of known) {
    if (listedWebIds.has(id) && perIdUris(id).every((uri) => ResourceRegistry.getResource(uri))) {
      continue;
    }
    for (const entry of PER_ID_FORMATS) {
      ResourceRegistry.register(
        prototypeResourceUri(id, entry.format),
        prototypeResourceName(id, entry.format),
        {
          title: `${id} (${entry.title})`,
          description: entry.description(id),
          mimeType: entry.mimeType,
          handler: async () => entry.read(sources, id),
        },
      );
    }
    listedWebIds.add(id);
    changed = true;
  }
  return changed;
}

/**
 * A new revision changes every format of its id, and the web page and embed envelope of every
 * variant sharing its group (only those two report variants).
 */
async function onWebRevision(
  sources: PrototypeWebSources,
  event: PrototypeSpecRevisionEvent,
): Promise<void> {
  if (syncWebResources(sources)) {
    await ResourceRegistry.notifyResourceListChanged();
  }
  const known = new Set(sources.revisions.ids());
  const formerGroup = webGroups.get(event.id);
  const former = [...webGroups]
    .filter(([id, group]) => formerGroup !== undefined && group === formerGroup && known.has(id))
    .map(([id]) => id);
  webGroups = nextGroups(sources.revisions, event, known);
  // The event's id and its current siblings change, and so do the siblings it left (or, when
  // evicted, the group it was dropped from).
  const current = known.has(event.id) ? prototypeVariantIds(sources.revisions, event.id) : [];
  const ids = new Set([...(known.has(event.id) ? [event.id] : []), ...current, ...former]);
  const uris = new Set([
    ...[...ids].flatMap((id) => [prototypeWebUri(id), prototypeEmbedUri(id)]),
    ...(known.has(event.id) ? perIdUris(event.id) : []),
  ]);
  if (uris.size > 0) {
    await ResourceRegistry.notifyResourcesUpdated([...uris]);
  }
}

/** Each known id's variant group, as of the last notification. */
let webGroups = new Map<string, string | undefined>();

function groupsOf(source: PrototypeSpecRevisionSource): Map<string, string | undefined> {
  return new Map(source.ids().map((id) => [id, source.revision(id).variant?.group]));
}

/**
 * The groups after this event. The store announces a revision before the evictions it caused, so
 * an id that has vanished keeps its last group until its own eviction event has been handled.
 */
function nextGroups(
  source: PrototypeSpecRevisionSource,
  event: PrototypeSpecRevisionEvent,
  known: ReadonlySet<string>,
): Map<string, string | undefined> {
  const next = groupsOf(source);
  for (const [id, group] of webGroups) {
    if (!known.has(id) && !(event.kind === "evicted" && event.id === id)) {
      next.set(id, group);
    }
  }
  return next;
}

function registerSourceTemplate(
  sources: PrototypeWebSources,
  template: string,
  format: PrototypeSourceFormat,
  label: string,
): void {
  ResourceRegistry.registerTemplate(template, `Prototype as one ${label} file`, {
    description: `A shown prototype as one ${label} source file: the spec inlined as a string constant, a header naming the renderer library, required capabilities and asset URIs, and a preview sized to the frame (frame: a device frame id; revision: a kept spec revision, default the latest)`,
    mimeType: prototypeSourceMimeType(format),
    handler: async (params: Record<string, string>) =>
      readSource(sources, format, {
        id: decodeSegmentOrThrow(params.id ?? ""),
        frame: params.frame,
        revision: params.revision,
      }),
  });
}

function registerPrototypeWebResources(sources: PrototypeWebSources): void {
  ResourceRegistry.registerTemplate(PROTOTYPE_WEB_TEMPLATE, "Prototype as a web page", {
    description:
      "A shown prototype as one self-contained HTML page in a device frame (frame: a device frame id; revision: a kept spec revision, default the latest; variant: the prototype id of its variant group shown first)",
    mimeType: "text/html",
    handler: async (params: Record<string, string>) =>
      readWeb(sources, {
        id: decodeSegmentOrThrow(params.id ?? ""),
        frame: params.frame,
        revision: params.revision,
        variant: params.variant,
      }),
  });
  ResourceRegistry.registerTemplate(PROTOTYPE_EMBED_TEMPLATE, "Prototype as an embed envelope", {
    description:
      'A shown prototype as {format: "automobile-prototype-embed", version: 1, requires, spec} for the web renderer library, requires being the capabilities the spec needs (revision: a kept spec revision, default the latest; variant: the prototype id of its variant group to serve)',
    mimeType: "application/json",
    handler: async (params: Record<string, string>) =>
      readEmbed(sources, {
        id: decodeSegmentOrThrow(params.id ?? ""),
        revision: params.revision,
        variant: params.variant,
      }),
  });
  registerSourceTemplate(sources, PROTOTYPE_COMPOSE_TEMPLATE, "compose", "Jetpack Compose");
  registerSourceTemplate(sources, PROTOTYPE_SWIFTUI_TEMPLATE, "swiftui", "SwiftUI");
  syncWebResources(sources);
  ResourceRegistry.registerListRefresher("prototype-web", async () => {
    syncWebResources(sources);
  });
  webGroups = groupsOf(sources.revisions);
  unsubscribeWeb?.();
  unsubscribeWeb = sources.revisions.onRevision((event) => {
    // Chained so notifications go out in revision order.
    webNotifications = webNotifications
      .then(() => onWebRevision(sources, event))
      .catch((error) => {
        // A failed notification must not fail the show or patch that recorded the revision.
        logger.warn(`[prototype] web resource notification failed for ${event.id}`, error);
      });
  });
}

/** Resolves once every web resource notification queued so far has been sent. */
export function prototypeWebNotificationsSettled(): Promise<void> {
  return webNotifications;
}

/**
 * Registers the `prototype` authoring guide, its icon lookup (#11052), the native-code
 * resources (#13729), the eject scaffold (#14129), the per-prototype web page and
 * Compose/SwiftUI files (#16345) and the per-prototype embed envelope (#16452).
 */
export function registerPrototypeResources(
  nativeSources: NativePrototypeSources = defaultNativePrototypeSources(),
  webSources: PrototypeWebSources = defaultPrototypeWebSources(),
): void {
  registerPrototypeWebResources(webSources);
  ResourceRegistry.register(PROTOTYPE_GUIDE_URI, "Prototype authoring guide", {
    description:
      "Node and action vocabulary, repeat grammar, limits, theme roles and icon lookup for the prototype tool",
    mimeType: "text/markdown",
    handler: async () => ({
      uri: PROTOTYPE_GUIDE_URI,
      mimeType: "text/markdown",
      text: renderPrototypeGuide(),
    }),
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_ICONS_TEMPLATE, "Prototype icon lookup", {
    description: `Material icon names containing the query (at most ${ICON_LOOKUP_LIMIT} per read)`,
    mimeType: "application/json",
    handler: async (params: Record<string, string>) => {
      const query = params.query ?? "";
      const { total, names } = searchIcons(query);
      return {
        uri: `${PROTOTYPE_ICONS_URI}?query=${encodeUriSegment(query)}`,
        mimeType: "application/json",
        text: JSON.stringify({ query, total, truncated: total > names.length, names }),
      };
    },
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_NATIVE_TEMPLATE, "Prototype as native app code", {
    description:
      "The prototype's spec, assets and a Jetpack Compose or SwiftUI host file that renders it with the published AutoMobile prototype library",
    mimeType: "application/json",
    handler: async (params: Record<string, string>) => {
      const native = await readNativePrototype(params, nativeSources);
      const query = new URLSearchParams(params).toString();
      return {
        uri: query ? `${PROTOTYPE_NATIVE_URI}?${query}` : PROTOTYPE_NATIVE_URI,
        mimeType: "application/json",
        text: JSON.stringify(native, null, 2),
      };
    },
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_EJECT_TEMPLATE, "Prototype ejected to app code", {
    description:
      "A one-shot Jetpack Compose or SwiftUI scaffold of the prototype that the app owns, with no renderer dependency: layout, text, buttons, fields, lists and stack navigation, TODO stubs for the rest",
    mimeType: "application/json",
    handler: async (params: Record<string, string>) => {
      const ejected = await readPrototypeEject(params, nativeSources);
      const query = new URLSearchParams(params).toString();
      return {
        uri: query ? `${PROTOTYPE_EJECT_URI}?${query}` : PROTOTYPE_EJECT_URI,
        mimeType: "application/json",
        text: JSON.stringify(ejected, null, 2),
      };
    },
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_NATIVE_ASSET_TEMPLATE, "Prototype asset bytes", {
    description: "One saved prototype's image or font, base64 encoded",
    mimeType: "application/octet-stream",
    handler: async (params: Record<string, string>) => {
      const asset = await readNativePrototypeAsset(params, nativeSources);
      return {
        uri: `${PROTOTYPE_NATIVE_ASSET_URI}?${new URLSearchParams(params).toString()}`,
        mimeType: asset.mimeType,
        blob: Buffer.from(asset.bytes).toString("base64"),
      };
    },
  });
}
