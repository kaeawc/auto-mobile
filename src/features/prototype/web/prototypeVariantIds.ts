import type { PrototypeSpecRevisionSource } from "../prototypeSpecRevisions";

/** Ids sharing `id`'s variant group (by each id's latest revision), in first-seen order. */
export function prototypeVariantIds(source: PrototypeSpecRevisionSource, id: string): string[] {
  const group = source.revision(id).variant?.group;
  if (group === undefined) {
    return [id];
  }
  return source.ids().filter((candidate) => source.revision(candidate).variant?.group === group);
}
