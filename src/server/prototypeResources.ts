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
  PROTOTYPE_NATIVE_ASSET_TEMPLATE,
  PROTOTYPE_NATIVE_ASSET_URI,
  PROTOTYPE_NATIVE_TEMPLATE,
  PROTOTYPE_NATIVE_URI,
} from "../features/prototype/nativePrototypeUris";
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
  PROTOTYPE_WEB_TEMPLATE,
  prototypeWebResourceName,
  prototypeWebUri,
} from "../features/prototype/prototypeWebUris";
import {
  prototypeVariantIds,
  readPrototypeWebResource,
  type PrototypeWebResourceQuery,
} from "../features/prototype/web/prototypeWebResource";
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

/** Where the web resource reads spec revisions and the version stamped into its `_meta`. */
export interface PrototypeWebSources {
  readonly revisions: PrototypeSpecRevisionSource;
  readonly rendererVersion: () => string;
}

export function defaultPrototypeWebSources(): PrototypeWebSources {
  return {
    revisions: daemonPrototypeSpecRevisions(),
    rendererVersion: () => releaseVersion(getMcpServerVersion()),
  };
}

function readWeb(sources: PrototypeWebSources, query: PrototypeWebResourceQuery): ResourceContent {
  const web = readPrototypeWebResource(sources.revisions, query, sources.rendererVersion());
  const params = new URLSearchParams(
    Object.entries({ frame: query.frame, revision: query.revision, variant: query.variant })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  ).toString();
  const uri = prototypeWebUri(query.id);
  return {
    uri: params ? `${uri}?${params}` : uri,
    mimeType: "text/html",
    text: web.html,
    _meta: { ...web.meta },
  };
}

/** Ids whose concrete web resource this module registered, so stale ones can be unregistered. */
const listedWebIds = new Set<string>();
let unsubscribeWeb: (() => void) | undefined;
let webNotifications: Promise<void> = Promise.resolve();

/** Registers one parameter-free resource per known id and drops evicted ones; true if it changed. */
function syncWebResources(sources: PrototypeWebSources): boolean {
  const known = new Set(sources.revisions.ids());
  let changed = false;
  for (const id of listedWebIds) {
    if (!known.has(id)) {
      ResourceRegistry.unregister(prototypeWebUri(id));
      listedWebIds.delete(id);
      changed = true;
    }
  }
  for (const id of known) {
    if (listedWebIds.has(id) && ResourceRegistry.getResource(prototypeWebUri(id))) {
      continue;
    }
    ResourceRegistry.register(prototypeWebUri(id), prototypeWebResourceName(id), {
      title: `${id} (web)`,
      description: `Prototype ${id} as a self-contained HTML page in a device frame (latest revision)`,
      mimeType: "text/html",
      handler: async () => readWeb(sources, { id }),
    });
    listedWebIds.add(id);
    changed = true;
  }
  return changed;
}

/** A new revision changes the page of its id and of every variant sharing its group. */
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
  if (ids.size > 0) {
    await ResourceRegistry.notifyResourcesUpdated([...ids].map(prototypeWebUri));
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
 * resources (#13729) and the per-prototype web page (#16345).
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
