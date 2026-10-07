/** Physical-device dumps can exceed execFile's 1 MiB default (notably Gboard).
 * Keep full parser input with headroom, while bounding each output stream. */
export const DUMPSYS_MAX_BUFFER = 16 * 1024 * 1024;
