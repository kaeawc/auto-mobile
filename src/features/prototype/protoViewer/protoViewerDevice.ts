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
export interface ProtoViewerDevice {
  installed(signal?: AbortSignal): Promise<boolean>;
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
