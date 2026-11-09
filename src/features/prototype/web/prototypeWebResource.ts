import { ActionableError } from "../../../models";
import type {
  PrototypeSpecRevision,
  PrototypeSpecRevisionFilter,
  PrototypeSpecRevisionSource,
} from "../prototypeSpecRevisions";
import { defaultDeviceFrameId, deviceFrameOrThrow } from "./deviceFrames";
import { withActionableWebInputAsync } from "./prototypeWebInputActionable";
import { type PrototypeWebVariant } from "./webPage";
import { prototypeVariantIds } from "./prototypeVariantIds";
import {
  buildPrototypeWebPageWithImages,
  type PrototypeWebAssetSource,
  type PrototypeWebImageEncoder,
} from "./webImageEncoding";

/** Where the page reads asset bytes for the given variant ids, and how it re-encodes them. */
export interface PrototypeWebImageSources {
  assets(variantIds: readonly string[]): PrototypeWebAssetSource;
  readonly encoder: PrototypeWebImageEncoder;
}

/** No asset bytes: every image draws its placeholder. */
export const NO_PROTOTYPE_WEB_IMAGES: PrototypeWebImageSources = {
  assets: () => ({ get: async () => undefined }),
  encoder: {
    encode: async () => {
      throw new Error("No prototype web image encoder");
    },
  },
};

/** Query parameters of `automobile:prototype/{id}/web`, the id already decoded. */
export interface PrototypeWebResourceQuery {
  readonly id: string;
  readonly frame?: string;
  readonly revision?: string;
  readonly variant?: string;
  /** Only this MCP session's revisions (#17358); absent for every session's. */
  readonly mcpSessionId?: string;
}

export interface PrototypeWebResourceMeta {
  readonly revision: number;
  readonly deviceRevision?: number;
  /** The MCP session that produced the revision shown first, when known (#17358). */
  readonly mcpSessionId?: string;
  /** Kept revisions of the variant shown first (only the filtered session's), oldest first. */
  readonly revisions: readonly number[];
  /** Prototype ids shown as variants, in page order. */
  readonly variants: readonly string[];
  readonly frame: string;
  readonly sha256: string;
  readonly rendererVersion: string;
}

export interface PrototypeWebResource {
  readonly html: string;
  readonly meta: PrototypeWebResourceMeta;
  /** Host time of the revision shown first. */
  readonly lastModified: number;
}

export function parsePrototypeRevision(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new ActionableError(
      `Invalid prototype revision "${value}": use a positive integer, or omit revision for the latest.`,
    );
  }
  return Number(value);
}

/** The revision filter of a resource's `mcpSessionId` query parameter (#17358). */
export function prototypeRevisionFilter(
  mcpSessionId: string | undefined,
): PrototypeSpecRevisionFilter | undefined {
  if (mcpSessionId === undefined) {
    return undefined;
  }
  if (mcpSessionId.trim().length === 0) {
    throw new ActionableError(
      "Invalid prototype mcpSessionId: use the mcpSessionId a show or patch returned, or omit it for every session's revisions.",
    );
  }
  return { mcpSessionId };
}

function webVariant(source: PrototypeSpecRevisionSource, id: string): PrototypeWebVariant {
  return {
    id,
    label: source.revision(id).variant?.label ?? id,
    revisions: source.history(id).map(({ revision, operation, spec }) => ({
      revision,
      operation,
      spec,
    })),
  };
}

/** The variant `query` shows first and its requested revision; unknown variants are refused. */
export function shownRevision(
  source: PrototypeSpecRevisionSource,
  query: Pick<PrototypeWebResourceQuery, "id" | "revision" | "variant" | "mcpSessionId">,
  variantIds: readonly string[],
): { id: string; revision: PrototypeSpecRevision } {
  const id = query.variant ?? query.id;
  if (!variantIds.includes(id)) {
    throw new ActionableError(
      `Unknown variant "${id}" for prototype "${query.id}". Variants: ${variantIds.join(", ")}.`,
    );
  }
  const filter = prototypeRevisionFilter(query.mcpSessionId);
  return { id, revision: source.revision(id, parsePrototypeRevision(query.revision), filter) };
}

/**
 * The prototype as one self-contained HTML page (#16345): every variant of its group with each
 * kept spec revision, the requested variant and revision shown first. The frame defaults to the
 * default frame of the platform that showed that revision, else Android's. Referenced image assets
 * the host has bytes for are inlined while the page budget allows (#16533).
 */
export async function readPrototypeWebResource(
  source: PrototypeSpecRevisionSource,
  query: PrototypeWebResourceQuery,
  rendererVersion: string,
  images: PrototypeWebImageSources = NO_PROTOTYPE_WEB_IMAGES,
): Promise<PrototypeWebResource> {
  return withActionableWebInputAsync(() =>
    buildWebResource(source, query, rendererVersion, images),
  );
}

async function buildWebResource(
  source: PrototypeSpecRevisionSource,
  query: PrototypeWebResourceQuery,
  rendererVersion: string,
  images: PrototypeWebImageSources,
): Promise<PrototypeWebResource> {
  const variantIds = prototypeVariantIds(source, query.id);
  const shown = shownRevision(source, query, variantIds);
  const platform = shown.revision.platform ?? "android";
  const frame = deviceFrameOrThrow(query.frame ?? defaultDeviceFrameId(platform)).id;
  const group = source.revision(query.id).variant?.group;
  // Read before awaiting the encoder: a show landing meanwhile, or the byte cap evicting this id,
  // must not change the metadata of the page already being built.
  const filter = prototypeRevisionFilter(query.mcpSessionId);
  const revisions = source.history(shown.id, filter).map((entry) => entry.revision);
  const page = await buildPrototypeWebPageWithImages(
    {
      title: group ?? query.id,
      variants: variantIds.map((id) => webVariant(source, id)),
      variant: shown.id,
      revision: shown.revision.revision,
      frame,
      platform,
    },
    images.assets(variantIds),
    images.encoder,
  );
  const { deviceRevision, mcpSessionId } = shown.revision;
  return {
    html: page.html,
    lastModified: shown.revision.time,
    meta: {
      revision: shown.revision.revision,
      ...(deviceRevision === undefined ? {} : { deviceRevision }),
      ...(mcpSessionId === undefined ? {} : { mcpSessionId }),
      revisions,
      variants: variantIds,
      frame: page.frame,
      sha256: page.sha256,
      rendererVersion,
    },
  };
}
