import type { PrototypeSpecRevisionSource } from "../prototypeSpecRevisions";
import { prototypeVariantIds } from "../web/prototypeVariantIds";

/** What one preview page asks for; mirrors the `automobile:prototype/<id>/web` query. */
export interface PrototypePreviewPageQuery {
  readonly id: string;
  readonly variant?: string;
  readonly frame?: string;
}

/**
 * What the preview server reads (#17975): the current web output of shown prototypes and a signal
 * when it changes. The server never renders or stores a spec itself, so any producer of web
 * output (a real device's acknowledged show and patch today, headless mode later) plugs in here.
 */
export interface PrototypePreviewPageSource {
  /** Prototype ids with web output, in first-seen order. */
  ids(): readonly string[];
  has(id: string): boolean;
  /** Ids whose change reloads `id`'s page: the id itself and, once known, its variant group. */
  related(id: string): readonly string[];
  /** The page HTML. Rejects with an ActionableError for an invalid query (variant, frame). */
  page(query: PrototypePreviewPageQuery): Promise<string>;
  /** Called with the id whose web output changed (a show, a landed patch, an eviction). */
  onChange(listener: (id: string) => void): () => void;
}

/**
 * The source over the spec revisions the web resource reads, with `readPage` rendering one page
 * exactly as `automobile:prototype/<id>/web` does.
 */
export function revisionPreviewPageSource(
  revisions: PrototypeSpecRevisionSource,
  readPage: (query: PrototypePreviewPageQuery) => Promise<string>,
): PrototypePreviewPageSource {
  const has = (id: string) => revisions.ids().includes(id);
  return {
    ids: () => revisions.ids(),
    has,
    related: (id) => (has(id) ? prototypeVariantIds(revisions, id) : [id]),
    page: readPage,
    onChange: (listener) => revisions.onRevision((event) => listener(event.id)),
  };
}
