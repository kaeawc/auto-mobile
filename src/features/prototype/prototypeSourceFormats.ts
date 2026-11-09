/**
 * `automobile:prototype/{id}/compose` and `.../swiftui` (#16345): one source file per prototype,
 * rendered by the same host-file template as `automobile:prototype/native` with the spec inlined.
 */
export type PrototypeSourceFormat = "compose" | "swiftui";

/** The MIME type each single-file format is served as, without loading its renderer. */
export const PROTOTYPE_SOURCE_MIME_TYPES: Readonly<Record<PrototypeSourceFormat, string>> = {
  compose: "text/x-kotlin",
  swiftui: "text/x-swift",
};
