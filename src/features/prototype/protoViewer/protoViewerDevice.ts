import { ActionableError } from "../../../models/ActionableError";
import type { ProtoViewerResult } from "./protoViewerContract";
export { ProtoViewerEntryPointMissingError } from "./ProtoViewerEntryPointMissingError";
export { ProtoViewerForegroundError } from "./ProtoViewerForegroundError";
export { ProtoViewerStorageError } from "./ProtoViewerStorageError";
export interface ProtoViewerTempFile {
  readonly path: string;
  dispose(): Promise<void>;
}
export interface ProtoViewerTempFiles {
  write(bytes: Uint8Array): Promise<ProtoViewerTempFile>;
}
/** The installed build's own answer to "what can you render" (#14156). */
export interface ProtoViewerCapabilityReport {
  /** The installed build's version name, for messages; absent when the app did not say. */
  version?: string;
  capabilities: ReadonlySet<string>;
  /** Where to get a newer build on this platform. */
  updateUrl?: string;
}

export interface ProtoViewerCapabilityOptions {
  timeoutMs: number;
  /** Ask the app to describe itself again first, because the published report may be stale. */
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface ProtoViewerDevice {
  installed(signal?: AbortSignal): Promise<boolean>;
  /**
   * Undefined when the installed build does not publish its capabilities (it predates the
   * handshake, or the platform has no handshake yet): the app's own import gate then decides.
   */
  capabilities(
    options: ProtoViewerCapabilityOptions,
  ): Promise<ProtoViewerCapabilityReport | undefined>;
  importBundle(
    bytes: Uint8Array,
    label: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProtoViewerResult>;
  open(libraryId: string, timeoutMs: number, signal?: AbortSignal): Promise<ProtoViewerResult>;
}
export const PROTOVIEWER_RESULT_POLL_MS = 250;
export const PROTOVIEWER_DEFAULT_TIMEOUT_MS = 15_000;
export const PROTOVIEWER_CLEANUP_TIMEOUT_MS = 5_000;

/** Simulator builds must advertise file delivery before the host publishes a command. */
export class ProtoViewerInboxUnsupportedError extends ActionableError {
  constructor() {
    super(
      "This ProtoViewer build did not advertise file inbox delivery. Install a newer ProtoViewer built with scripts/ios/protoviewer-build.sh and retry.",
    );
    this.name = "ProtoViewerInboxUnsupportedError";
  }
}
