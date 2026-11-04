import { createHash } from "node:crypto";
import { requiredPrototypeCapabilities } from "../prototypeCapabilityGates";
import type { ShownSpecJson } from "../PrototypeShownSpecs";
import type { PrototypeSpecRevisionSource } from "../prototypeSpecRevisions";
import { prototypeEmbedGlyphs } from "./prototypeEmbedGlyphs";
import { materialIconGlyphs } from "./materialIconGlyphs";
import type { PrototypeIconGlyphSource } from "./webIconGlyphs";
import { prototypeVariantIds, shownRevision } from "./prototypeWebResource";

/** The envelope's `format`, so an embedder can tell it from a bare spec. */
export const PROTOTYPE_EMBED_FORMAT = "automobile-prototype-embed";
/** The envelope version; the web library refuses a version it does not know. */
export const PROTOTYPE_EMBED_VERSION = 1;

/**
 * What `automobile:prototype/{id}/embed` serves (#16452): a spec plus the capabilities the host
 * that validated it computed, so the web library can refuse a spec it cannot draw whole.
 */
export interface PrototypeEmbedEnvelope {
  readonly format: typeof PROTOTYPE_EMBED_FORMAT;
  readonly version: typeof PROTOTYPE_EMBED_VERSION;
  readonly requires: readonly string[];
  readonly spec: ShownSpecJson;
  /**
   * Additive within version 1, present only when at least one glyph resolves: the glyph of
   * every `<variant>/<name>` its icon fields, `state` and `data` can name, as SVG markup for a
   * 24 x 24 viewBox, so an interactive renderer needs no icon set of its own.
   */
  readonly glyphs?: Readonly<Record<string, string>>;
  /** Keys the glyph source has no glyph for; the renderer draws its placeholder for them. */
  readonly iconMissing?: readonly string[];
}

/** Query parameters of `automobile:prototype/{id}/embed`, the id already decoded. */
export interface PrototypeEmbedResourceQuery {
  readonly id: string;
  readonly revision?: string;
  readonly variant?: string;
}

/** The web resource's `_meta` without `frame`: an envelope has no device frame. */
export interface PrototypeEmbedResourceMeta {
  readonly revision: number;
  readonly deviceRevision?: number;
  /** Kept revisions of the variant served, oldest first. */
  readonly revisions: readonly number[];
  /** Prototype ids of the variant group, in the web page's order. */
  readonly variants: readonly string[];
  readonly sha256: string;
  readonly rendererVersion: string;
}

export interface PrototypeEmbedResource {
  readonly text: string;
  readonly envelope: PrototypeEmbedEnvelope;
  readonly meta: PrototypeEmbedResourceMeta;
}

export function prototypeEmbedEnvelope(
  spec: ShownSpecJson,
  glyphSource: PrototypeIconGlyphSource = materialIconGlyphs(),
): PrototypeEmbedEnvelope {
  const { glyphs, iconMissing } = prototypeEmbedGlyphs(spec, glyphSource);
  return {
    format: PROTOTYPE_EMBED_FORMAT,
    version: PROTOTYPE_EMBED_VERSION,
    requires: requiredPrototypeCapabilities(spec),
    spec,
    ...(Object.keys(glyphs).length > 0 ? { glyphs } : {}),
    ...(iconMissing.length > 0 ? { iconMissing } : {}),
  };
}

/**
 * One kept revision of a prototype, or of a variant in its group, as an embed envelope. Revision,
 * variant and errors follow `readPrototypeWebResource`.
 */
export function readPrototypeEmbedResource(
  source: PrototypeSpecRevisionSource,
  query: PrototypeEmbedResourceQuery,
  rendererVersion: string,
  glyphSource?: PrototypeIconGlyphSource,
): PrototypeEmbedResource {
  const variantIds = prototypeVariantIds(source, query.id);
  const shown = shownRevision(source, query, variantIds);
  const envelope = prototypeEmbedEnvelope(shown.revision.spec, glyphSource);
  const text = JSON.stringify(envelope);
  const { deviceRevision } = shown.revision;
  return {
    text,
    envelope,
    meta: {
      revision: shown.revision.revision,
      ...(deviceRevision === undefined ? {} : { deviceRevision }),
      revisions: source.history(shown.id).map((entry) => entry.revision),
      variants: variantIds,
      sha256: createHash("sha256").update(text).digest("hex"),
      rendererVersion,
    },
  };
}
