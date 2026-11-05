import path from "node:path";
import { hasElementAnchors } from "../prototypeAnchors";
import type {
  PrototypeAssetFileReader,
  PrototypeAssetSource,
  PrototypeObservationScreenshotReader,
} from "../prototypeAssetUploader";
import { bundleSha256 } from "../bundle/bundleManifest";
import type { PrototypeSpec } from "../prototypeSpec";
import {
  canonicalProtoViewerBundle,
  type ProtoViewerErrorCode,
  type ProtoViewerOutput,
} from "./protoViewerSaved";
import {
  MAX_PROTOVIEWER_IMPORT_LINK_BYTES,
  protoViewerImportLink,
  protoViewerShareUrlProblem,
} from "./protoViewerShareLink";
import { encodeQr, qrPng, qrTerminal } from "./protoViewerShareQr";

/** Draws a link as a QR; injected so tests skip the PNG encode. */
export interface ProtoViewerShareQrRenderer {
  render(text: string): { png: Uint8Array; terminal: string };
}

export const defaultProtoViewerShareQrRenderer: ProtoViewerShareQrRenderer = {
  render(text) {
    const matrix = encodeQr(text);
    return { png: qrPng(matrix), terminal: qrTerminal(matrix) };
  },
};

/** Where share writes; injected so tests never touch the real data directory. */
export interface ProtoViewerShareFiles {
  /** Absolute directory share files are written into; created when missing. */
  outputDir(): string;
  write(filePath: string, bytes: Uint8Array): Promise<void>;
}

export interface ProtoViewerShareDependencies {
  assetFileReader: PrototypeAssetFileReader;
  observationScreenshotReader: PrototypeObservationScreenshotReader;
  files: ProtoViewerShareFiles;
  qr?: ProtoViewerShareQrRenderer;
}

export interface ProtoViewerShareInput {
  spec: PrototypeSpec;
  assets?: readonly PrototypeAssetSource[];
  /** The https URL the team will upload the bundle to; without it only the bundle is written. */
  url?: string;
}

export interface ProtoViewerShare {
  bundlePath: string;
  sha256: string;
  bytes: number;
  url?: string;
  link?: string;
  qrPngPath?: string;
  qr?: string;
}

export interface ProtoViewerShareOutput extends Omit<ProtoViewerOutput, "errorCode" | "viewer"> {
  errorCode?: ProtoViewerErrorCode | "invalid_url";
  share?: ProtoViewerShare;
}

const NOTHING_SHARED = "Nothing was written.";

/**
 * Writes the canonical bundle and, given the URL it will be hosted at, the import link and its QR.
 * The host uploads nothing (#14128 owner decision: the team supplies the static https host).
 */
export async function shareProtoViewerBundle(
  input: ProtoViewerShareInput,
  deps: ProtoViewerShareDependencies,
): Promise<ProtoViewerShareOutput> {
  const urlProblem = input.url === undefined ? undefined : protoViewerShareUrlProblem(input.url);
  if (urlProblem) {
    return failure("invalid_url", `${urlProblem}. ${NOTHING_SHARED}`);
  }
  if (hasElementAnchors(input.spec)) {
    return failure(
      "invalid_spec",
      `Element anchors are resolved against the live screen and cannot be shared; use {type:"bounds",bounds:{x,y,width,height}} anchors (dp) instead. ${NOTHING_SHARED}`,
    );
  }
  const bundle = await canonicalProtoViewerBundle(input, input.spec, deps, NOTHING_SHARED);
  if ("failure" in bundle) {
    return bundle.failure;
  }
  const sha256 = bundleSha256(bundle.bytes);
  const link = input.url === undefined ? undefined : protoViewerImportLink(input.url, sha256);
  if (link !== undefined && Buffer.byteLength(link) > MAX_PROTOVIEWER_IMPORT_LINK_BYTES) {
    return failure(
      "invalid_url",
      `The import link is ${Buffer.byteLength(link)} bytes, over ${MAX_PROTOVIEWER_IMPORT_LINK_BYTES}, too dense for a phone camera to read as a QR; use a shorter url. ${NOTHING_SHARED}`,
    );
  }
  const directory = deps.files.outputDir();
  const stem = `${fileStem(input.spec.id)}-${sha256.slice(0, 12)}`;
  const bundlePath = path.join(directory, `${stem}.automobile-proto`);
  await deps.files.write(bundlePath, bundle.bytes);
  const share: ProtoViewerShare = { bundlePath, sha256, bytes: bundle.bytes.length };
  if (link === undefined || input.url === undefined) {
    return {
      success: true,
      share,
      warning:
        "No url was given, so there is no link or QR. Upload the bundle to a static https host, then share again with url set to where it is served.",
    };
  }
  const qr = (deps.qr ?? defaultProtoViewerShareQrRenderer).render(link);
  // One bundle can be shared at several URLs: the QR is named by its link, never overwritten.
  const linkId = bundleSha256(Buffer.from(link)).slice(0, 12);
  const qrPngPath = path.join(directory, `${stem}-${linkId}.qr.png`);
  await deps.files.write(qrPngPath, qr.png);
  return {
    success: true,
    share: { ...share, url: input.url, link, qrPngPath, qr: qr.terminal },
    warning: `Upload ${bundlePath} so it is served byte-for-byte at ${input.url}; ProtoViewer refuses any other bytes. The link and QR open in an Android ProtoViewer that supports URL import, which asks before downloading; until then, or on iOS, send the bundle file itself and open it in ProtoViewer.`,
  };
}

/** A spec id is free text: keep only filename-safe characters so it can never leave the directory. */
export function fileStem(specId: string): string {
  const safe = specId
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safe === "" ? "prototype" : safe;
}

function failure(errorCode: "invalid_url" | "invalid_spec", error: string): ProtoViewerShareOutput {
  return { success: false, errorCode, error };
}
