import { createHash } from "node:crypto";
import { requiredPrototypeCapabilities } from "../prototypeCapabilityGates";
import type { ShownSpecJson } from "../PrototypeShownSpecs";
import type { PrototypeSpecRevisionSource } from "../prototypeSpecRevisions";
import { prototypeEmbedGlyphs } from "./prototypeEmbedGlyphs";
import { materialIconGlyphs } from "./materialIconGlyphs";
import type { PrototypeIconGlyphSource } from "./webIconGlyphs";
import { prototypeRevisionFilter, shownRevision } from "./prototypeWebResource";
import { prototypeVariantIds } from "./prototypeVariantIds";
import {
  PROTOTYPE_EMBED_FORMAT,
  PROTOTYPE_EMBED_VERSION,
  type PrototypeEmbedEnvelope,
} from "./prototypeEmbedFormat";

export {
  PROTOTYPE_EMBED_FORMAT,
  PROTOTYPE_EMBED_VERSION,
  type PrototypeEmbedEnvelope,
} from "./prototypeEmbedFormat";

/** Query parameters of `automobile:prototype/{id}/embed`, the id already decoded. */
export interface PrototypeEmbedResourceQuery {
  readonly id: string;
  readonly revision?: string;
  readonly variant?: string;
  /** Only this MCP session's revisions (#17358); absent for every session's. */
  readonly mcpSessionId?: string;
}

/** The web resource's `_meta` without `frame`: an envelope has no device frame. */
export interface PrototypeEmbedResourceMeta {
  readonly revision: number;
  readonly deviceRevision?: number;
  /** The MCP session that produced the revision served, when known (#17358). */
  readonly mcpSessionId?: string;
  /** Kept revisions of the variant served (only the filtered session's), oldest first. */
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
  const { deviceRevision, mcpSessionId } = shown.revision;
  const filter = prototypeRevisionFilter(query.mcpSessionId);
  return {
    text,
    envelope,
    meta: {
      revision: shown.revision.revision,
      ...(deviceRevision === undefined ? {} : { deviceRevision }),
      ...(mcpSessionId === undefined ? {} : { mcpSessionId }),
      revisions: source.history(shown.id, filter).map((entry) => entry.revision),
      variants: variantIds,
      sha256: createHash("sha256").update(text).digest("hex"),
      rendererVersion,
    },
  };
}
