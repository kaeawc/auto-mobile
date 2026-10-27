import { ActionableError } from "../../models/ActionableError";
import type { AppFileProviderCoverage } from "./storageCapabilities";

type CoverageSource = () => readonly AppFileProviderCoverage[];

let source: CoverageSource | undefined;

/** The server's app-file service registers the provider coverage it was built with. */
export function setDefaultAppFileProviderCoverageSource(next: CoverageSource | undefined): void {
  source = next;
}

export function describeDefaultAppFileProviderCoverage(): readonly AppFileProviderCoverage[] {
  if (!source) {
    throw new ActionableError(
      "No app-file provider coverage is registered; the MCP app-file service has not been loaded.",
    );
  }
  return source();
}
