import { encodeUriSegment } from "../../utils/encodeUriSegment";

/** URIs of the per-prototype web resource (#16345). */
export const PROTOTYPE_WEB_TEMPLATE = "automobile:prototype/{id}/web{?frame,revision,variant}";

/** The parameter-free URI: always the latest revision, listed and notified on every revision. */
export function prototypeWebUri(id: string): string {
  return `automobile:prototype/${encodeUriSegment(id)}/web`;
}

/** Stable `resources/list` name of a prototype's web resource. */
export function prototypeWebResourceName(id: string): string {
  return `prototype-${id}-web`;
}
