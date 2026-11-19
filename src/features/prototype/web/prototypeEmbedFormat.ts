import type { ShownSpecJson } from "../PrototypeShownSpecs";

// Browser-safe: the web library (#16453) reads envelopes, so the format lives apart from the
// Node-only resource reader in prototypeEmbedResource.ts.

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
