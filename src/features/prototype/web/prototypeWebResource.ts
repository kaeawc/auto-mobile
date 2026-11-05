import { ActionableError } from "../../../models";
import type { PrototypeSpecRevision, PrototypeSpecRevisionSource } from "../prototypeSpecRevisions";
import { defaultDeviceFrameId, deviceFrameOrThrow } from "./deviceFrames";
import { withActionableWebInput } from "./prototypeWebInputActionable";
import { buildPrototypeWebPage, type PrototypeWebVariant } from "./webPage";

/** Query parameters of `automobile:prototype/{id}/web`, the id already decoded. */
export interface PrototypeWebResourceQuery {
  readonly id: string;
  readonly frame?: string;
  readonly revision?: string;
  readonly variant?: string;
}

export interface PrototypeWebResourceMeta {
  readonly revision: number;
  readonly deviceRevision?: number;
  /** Kept revisions of the variant shown first, oldest first. */
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

/** Ids sharing `id`'s variant group (by each id's latest revision), in first-seen order. */
export function prototypeVariantIds(source: PrototypeSpecRevisionSource, id: string): string[] {
  const group = source.revision(id).variant?.group;
  if (group === undefined) {
    return [id];
  }
  return source.ids().filter((candidate) => source.revision(candidate).variant?.group === group);
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
  query: Pick<PrototypeWebResourceQuery, "id" | "revision" | "variant">,
  variantIds: readonly string[],
): { id: string; revision: PrototypeSpecRevision } {
  const id = query.variant ?? query.id;
  if (!variantIds.includes(id)) {
    throw new ActionableError(
      `Unknown variant "${id}" for prototype "${query.id}". Variants: ${variantIds.join(", ")}.`,
    );
  }
  return { id, revision: source.revision(id, parsePrototypeRevision(query.revision)) };
}

/**
 * The prototype as one self-contained HTML page (#16345): every variant of its group with each
 * kept spec revision, the requested variant and revision shown first. The frame defaults to the
 * default frame of the platform that showed that revision, else Android's.
 */
export function readPrototypeWebResource(
  source: PrototypeSpecRevisionSource,
  query: PrototypeWebResourceQuery,
  rendererVersion: string,
): PrototypeWebResource {
  return withActionableWebInput(() => buildWebResource(source, query, rendererVersion));
}

function buildWebResource(
  source: PrototypeSpecRevisionSource,
  query: PrototypeWebResourceQuery,
  rendererVersion: string,
): PrototypeWebResource {
  const variantIds = prototypeVariantIds(source, query.id);
  const shown = shownRevision(source, query, variantIds);
  const platform = shown.revision.platform ?? "android";
  const frame = deviceFrameOrThrow(query.frame ?? defaultDeviceFrameId(platform)).id;
  const group = source.revision(query.id).variant?.group;
  const page = buildPrototypeWebPage({
    title: group ?? query.id,
    variants: variantIds.map((id) => webVariant(source, id)),
    variant: shown.id,
    revision: shown.revision.revision,
    frame,
    platform,
  });
  const { deviceRevision } = shown.revision;
  return {
    html: page.html,
    lastModified: shown.revision.time,
    meta: {
      revision: shown.revision.revision,
      ...(deviceRevision === undefined ? {} : { deviceRevision }),
      revisions: source.history(shown.id).map((entry) => entry.revision),
      variants: variantIds,
      frame: page.frame,
      sha256: page.sha256,
      rendererVersion,
    },
  };
}
