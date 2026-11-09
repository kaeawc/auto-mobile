import type { PrototypeShownSpecs } from "../../features/prototype/PrototypeShownSpecs";
import { PrototypeSpecRevisions } from "../../features/prototype/prototypeSpecRevisions";
import { defaultTimer } from "../../utils/SystemTimer";

/**
 * Daemon-wide prototype state the resources read, kept apart from the prototype runtime so they
 * can hold it without importing the tool's implementation (#17709).
 */

/** Spec revisions of the daemon host; they outlive any one host, for the daemon process (#16345). */
let daemonSpecRevisions: PrototypeSpecRevisions | undefined;

export function daemonPrototypeSpecRevisions(): PrototypeSpecRevisions {
  daemonSpecRevisions ??= new PrototypeSpecRevisions(defaultTimer);
  return daemonSpecRevisions;
}

/** Set by the runtime module when it is evaluated; until then no host exists. */
let shownSpecsReader: (() => PrototypeShownSpecs | undefined) | undefined;

export function setDaemonPrototypeShownSpecsReader(
  reader: () => PrototypeShownSpecs | undefined,
): void {
  shownSpecsReader = reader;
}

/** Specs the shared daemon host has seen acknowledged, for read-only resources (#13729). */
export function daemonPrototypeShownSpecs(): PrototypeShownSpecs | undefined {
  return shownSpecsReader?.();
}
