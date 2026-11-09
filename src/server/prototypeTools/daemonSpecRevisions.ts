import { PrototypeSpecRevisions } from "../../features/prototype/prototypeSpecRevisions";
import { defaultTimer } from "../../utils/SystemTimer";

/** Spec revisions of the daemon host; they outlive any one host, for the daemon process (#16345). */
let daemonSpecRevisions: PrototypeSpecRevisions | undefined;

/**
 * Kept apart from the prototype runtime so the resources that list revisions can hold them
 * without importing the tool's implementation (#17709).
 */
export function daemonPrototypeSpecRevisions(): PrototypeSpecRevisions {
  daemonSpecRevisions ??= new PrototypeSpecRevisions(defaultTimer);
  return daemonSpecRevisions;
}
