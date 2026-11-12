import type { PrototypePreviewControl } from "./PrototypePreviewServer";

/**
 * The daemon's prototype preview server (#17975), held apart from the server module so the
 * daemon's shutdown can stop it without loading the prototype runtime. Set when the runtime first
 * creates it; until then there is nothing to stop.
 */
let daemonPreview: Pick<PrototypePreviewControl, "stop"> | undefined;

export function setDaemonPrototypePreview(
  preview: Pick<PrototypePreviewControl, "stop"> | undefined,
): void {
  daemonPreview = preview;
}

/** Closes the daemon's preview server and its port, if one is running. */
export async function stopDaemonPrototypePreview(): Promise<void> {
  await daemonPreview?.stop("daemon");
}
