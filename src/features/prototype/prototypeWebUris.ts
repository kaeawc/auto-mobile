import { encodeUriSegment } from "../../utils/encodeUriSegment";

/** Formats served per prototype id under `automobile:prototype/{id}/{format}` (#16345). */
export type PrototypeResourceFormat = "web" | "embed" | "compose" | "swiftui";

/** URIs of the per-prototype web resource (#16345). */
export const PROTOTYPE_WEB_TEMPLATE =
  "automobile:prototype/{id}/web{?frame,revision,variant,mcpSessionId}";
/** URIs of the per-prototype embed envelope (#16452). */
export const PROTOTYPE_EMBED_TEMPLATE =
  "automobile:prototype/{id}/embed{?revision,variant,mcpSessionId}";
/** URIs of the per-prototype single-file Compose and SwiftUI resources (#16345). */
export const PROTOTYPE_COMPOSE_TEMPLATE =
  "automobile:prototype/{id}/compose{?frame,revision,mcpSessionId}";
export const PROTOTYPE_SWIFTUI_TEMPLATE =
  "automobile:prototype/{id}/swiftui{?frame,revision,mcpSessionId}";

/** The parameter-free URI of a format: always the latest revision, listed and notified. */
export function prototypeResourceUri(id: string, format: PrototypeResourceFormat): string {
  return `automobile:prototype/${encodeUriSegment(id)}/${format}`;
}

/** Stable `resources/list` name of a prototype's resource in one format. */
export function prototypeResourceName(id: string, format: PrototypeResourceFormat): string {
  return `prototype-${id}-${format}`;
}

/** The parameter-free URI: always the latest revision, listed and notified on every revision. */
export function prototypeWebUri(id: string): string {
  return prototypeResourceUri(id, "web");
}

/** The parameter-free embed URI: always the latest revision, listed and notified like the web URI. */
export function prototypeEmbedUri(id: string): string {
  return prototypeResourceUri(id, "embed");
}
