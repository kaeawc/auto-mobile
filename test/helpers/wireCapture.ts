import { isViewHierarchyResult, type ViewHierarchyResult } from "../../src/models";

/**
 * Accepts a capture exactly as it arrives off the wire (`unknown`): fixture data whose
 * legacy shape the model types forbid, such as array-shaped roots or array bounds from
 * older runners. It runs the same shallow check the daemon applies to a tool envelope and
 * throws on anything that is not a capture, so a typo in a fixture fails loudly. The
 * returned value is the input itself, so shared node identity survives.
 */
export function wireCapture(raw: unknown): ViewHierarchyResult {
  if (!isViewHierarchyResult(raw)) {
    throw new Error("wireCapture: fixture has no object `hierarchy`");
  }
  return raw;
}
