/**
 * The ProtoViewer URL-import link (#14128). The host publishes nothing: the team uploads the bundle
 * to a static https host of its choice, and the link carries that URL plus the bundle's SHA-256 so
 * ProtoViewer can show both on its confirmation screen and refuse a different download.
 */
export const PROTOVIEWER_IMPORT_LINK_PREFIX = "automobile-proto://import";

/** Keeps the QR at a version a phone camera reads from a laptop screen (about version 25 at M). */
export const MAX_PROTOVIEWER_IMPORT_LINK_BYTES = 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Why `url` cannot be a ProtoViewer share location, or undefined when it can. */
export function protoViewerShareUrlProblem(url: string): string | undefined {
  if (!URL.canParse(url)) {
    return "url must be an absolute https URL";
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    return "url must use https; ProtoViewer refuses any other scheme";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "url must not carry credentials; anyone who scans the QR would receive them";
  }
  if (parsed.hash !== "") {
    return "url must not have a #fragment; it is never sent to the host";
  }
  return undefined;
}

/** The custom-scheme link a QR carries. `url` must already pass {@link protoViewerShareUrlProblem}. */
export function protoViewerImportLink(url: string, sha256: string): string {
  if (!SHA256_HEX.test(sha256)) {
    throw new Error("sha256 must be 64 lowercase hex characters");
  }
  return `${PROTOVIEWER_IMPORT_LINK_PREFIX}?url=${encodeURIComponent(url)}&sha256=${sha256}`;
}
