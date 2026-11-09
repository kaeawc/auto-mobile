import { ResourceRegistry } from "./resourceRegistry";
import {
  ICON_LOOKUP_LIMIT,
  PROTOTYPE_GUIDE_URI,
  PROTOTYPE_ICONS_TEMPLATE,
  PROTOTYPE_SPEC_SCHEMA_URI,
} from "../features/prototype/prototypeGuideUris";
import type { NativePrototypeSources } from "../features/prototype/nativePrototype";
import {
  PROTOTYPE_EJECT_TEMPLATE,
  PROTOTYPE_NATIVE_ASSET_TEMPLATE,
  PROTOTYPE_NATIVE_TEMPLATE,
} from "../features/prototype/nativePrototypeUris";
import { defaultSavedPrototypeMirror } from "../features/prototype/savedPrototypeMirror";
import { getMcpServerVersion, releaseVersion } from "../utils/mcpVersion";
import {
  daemonPrototypeShownSpecs,
  daemonPrototypeSpecRevisions,
} from "./prototypeTools/daemonSpecRevisions";
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
  PROTOTYPE_SOURCE_MIME_TYPES,
  type PrototypeSourceFormat,
} from "../features/prototype/prototypeSourceFormats";
import type { PrototypeWebImageSources } from "../features/prototype/web/prototypeWebResource";
import { prototypeVariantIds } from "../features/prototype/web/prototypeVariantIds";
import type {
  PrototypeWebAssetSource,
  PrototypeWebImageEncoder,
} from "../features/prototype/web/webImageEncoding";
import {
  defaultPrototypeAssetCache,
  type PrototypeAssetCache,
} from "../features/prototype/prototypeAssetCache";
import { logger } from "../utils/logger";
import { errorMessage } from "../models/describeUnknownError";
import { lazyFeatureModule, type LazyFeatureModule } from "../utils/lazyFeatureModule";
import { decodeSegmentOrThrow } from "./resourceUriSegments";
import type { ResourceContent } from "./resourceRegistry";

/** What reading a prototype resource needs: the guide, renderers and templates (#17709). */
export type PrototypeResourceReaders = typeof import("./prototypeResourceReaders");

/**
 * Every prototype URI and template is registered at startup so `resources/list` is unchanged; the
 * module that reads them is imported on the first read.
 */
export const prototypeResourceReadersModule: LazyFeatureModule<PrototypeResourceReaders> =
  lazyFeatureModule("prototype resources", () => import("./prototypeResourceReaders"));

/** The readers the registered handlers use; registration can supply its own (tests). */
let activeReaders: LazyFeatureModule<PrototypeResourceReaders> = prototypeResourceReadersModule;

const readers = (): Promise<PrototypeResourceReaders> => activeReaders.load();

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
 * rather than drawing one device's image in another's variant. A device whose cache cannot be read
 * is skipped.
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
        let asset: Awaited<ReturnType<PrototypeAssetCache["get"]>>;
        try {
          asset = await cache.get(device, assetId);
        } catch (error) {
          // Another device may still have the asset; without one the image keeps its placeholder.
          logger.warn(
            `[PROTOTYPE] Asset cache read failed for ${assetId} on ${device}: ${errorMessage(error)}`,
            error,
          );
          continue;
        }
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

/** The sharp-backed encoder, imported with the readers on the first image it encodes. */
function lazyPrototypeWebImageEncoder(): PrototypeWebImageEncoder {
  let encoder: PrototypeWebImageEncoder | undefined;
  return {
    encode: async (bytes, boxes, options) => {
      encoder ??= (await readers()).createPrototypeWebImageEncoder();
      return await encoder.encode(bytes, boxes, options);
    },
  };
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
      encoder: lazyPrototypeWebImageEncoder(),
    },
  };
}

async function readWeb(
  sources: PrototypeWebSources,
  query: Parameters<PrototypeResourceReaders["readWeb"]>[1],
): Promise<ResourceContent> {
  return (await readers()).readWeb(sources, query);
}

async function readEmbed(
  sources: PrototypeWebSources,
  query: Parameters<PrototypeResourceReaders["readEmbed"]>[1],
): Promise<ResourceContent> {
  return (await readers()).readEmbed(sources, query);
}

async function readSource(
  sources: PrototypeWebSources,
  format: PrototypeSourceFormat,
  query: Parameters<PrototypeResourceReaders["readSource"]>[2],
): Promise<ResourceContent> {
  return (await readers()).readSource(sources, format, query);
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
  mimeType: PROTOTYPE_SOURCE_MIME_TYPES[format],
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
 * variant sharing its group (only those two report variants). It needs only the revision source,
 * never the lazily imported readers, so a failed reader import cannot drop an update (#17721).
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
    description: `A shown prototype as one ${label} source file: the spec inlined as a string constant, a header naming the renderer library, required capabilities and asset URIs, and a preview sized to the frame (frame: a device frame id; revision: a kept spec revision, default the latest; mcpSessionId: only the revisions that MCP session produced)`,
    mimeType: PROTOTYPE_SOURCE_MIME_TYPES[format],
    handler: async (params: Record<string, string>) =>
      readSource(sources, format, {
        id: decodeSegmentOrThrow(params.id ?? ""),
        frame: params.frame,
        revision: params.revision,
        mcpSessionId: params.mcpSessionId,
      }),
  });
}

function registerPrototypeWebResources(sources: PrototypeWebSources): void {
  ResourceRegistry.registerTemplate(PROTOTYPE_WEB_TEMPLATE, "Prototype as a web page", {
    description:
      "A shown prototype as one self-contained HTML page in a device frame (frame: a device frame id; revision: a kept spec revision, default the latest; variant: the prototype id of its variant group shown first; mcpSessionId: only the revisions that MCP session produced)",
    mimeType: "text/html",
    handler: async (params: Record<string, string>) =>
      readWeb(sources, {
        id: decodeSegmentOrThrow(params.id ?? ""),
        frame: params.frame,
        revision: params.revision,
        variant: params.variant,
        mcpSessionId: params.mcpSessionId,
      }),
  });
  ResourceRegistry.registerTemplate(PROTOTYPE_EMBED_TEMPLATE, "Prototype as an embed envelope", {
    description:
      'A shown prototype as {format: "automobile-prototype-embed", version: 1, requires, spec} for the web renderer library, requires being the capabilities the spec needs (revision: a kept spec revision, default the latest; variant: the prototype id of its variant group to serve; mcpSessionId: only the revisions that MCP session produced)',
    mimeType: "application/json",
    handler: async (params: Record<string, string>) =>
      readEmbed(sources, {
        id: decodeSegmentOrThrow(params.id ?? ""),
        revision: params.revision,
        variant: params.variant,
        mcpSessionId: params.mcpSessionId,
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
  readersModule: LazyFeatureModule<PrototypeResourceReaders> = prototypeResourceReadersModule,
): void {
  activeReaders = readersModule;
  registerPrototypeWebResources(webSources);
  ResourceRegistry.register(PROTOTYPE_GUIDE_URI, "Prototype authoring guide", {
    description:
      "Node and action vocabulary, repeat grammar, limits, theme roles and icon lookup for the prototype tool",
    mimeType: "text/markdown",
    handler: async () => (await readers()).readGuide(),
  });

  ResourceRegistry.register(PROTOTYPE_SPEC_SCHEMA_URI, "Prototype spec JSON Schema", {
    description:
      "Full JSON Schema (draft-07) of the prototype tool's spec: every node, action and field it accepts",
    mimeType: "application/schema+json",
    handler: async () => {
      // Loaded on first read: the schema module converts the whole spec contract.
      const { prototypeSpecJsonSchema } =
        await import("../features/prototype/prototypeSpecJsonSchema");
      return {
        uri: PROTOTYPE_SPEC_SCHEMA_URI,
        mimeType: "application/schema+json",
        text: JSON.stringify(prototypeSpecJsonSchema()),
      };
    },
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_ICONS_TEMPLATE, "Prototype icon lookup", {
    description: `Material icon names containing the query (at most ${ICON_LOOKUP_LIMIT} per read)`,
    mimeType: "application/json",
    handler: async (params: Record<string, string>) =>
      (await readers()).readIcons(params.query ?? ""),
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_NATIVE_TEMPLATE, "Prototype as native app code", {
    description:
      "The prototype's spec, assets and a Jetpack Compose or SwiftUI host file that renders it with the published AutoMobile prototype library",
    mimeType: "application/json",
    handler: async (params: Record<string, string>) =>
      (await readers()).readNative(params, nativeSources),
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_EJECT_TEMPLATE, "Prototype ejected to app code", {
    description:
      "A one-shot Jetpack Compose or SwiftUI scaffold of the prototype that the app owns, with no renderer dependency: layout, text, buttons, fields, lists and stack navigation, TODO stubs for the rest",
    mimeType: "application/json",
    handler: async (params: Record<string, string>) =>
      (await readers()).readEject(params, nativeSources),
  });

  ResourceRegistry.registerTemplate(PROTOTYPE_NATIVE_ASSET_TEMPLATE, "Prototype asset bytes", {
    description: "One saved prototype's image or font, base64 encoded",
    mimeType: "application/octet-stream",
    handler: async (params: Record<string, string>) =>
      (await readers()).readNativeAsset(params, nativeSources),
  });
}
