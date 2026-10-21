import type { HierarchyLayer } from "../../../models/HierarchyLayer";

/**
 * Per-execute target facts shared by the SendKeys orchestrator and its focus collaborator.
 * `execute` resets it at the start of every call; focusing a selector updates it.
 */
export class TargetState {
  /** The selector resolved to a password field during the current execute. */
  focusedPassword = false;
  effectiveLayer: HierarchyLayer | undefined;
  prototypeIdentifiers: readonly string[] = [];
}
