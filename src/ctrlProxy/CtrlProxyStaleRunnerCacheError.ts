import { ActionableError } from "../models/ActionableError";

/**
 * Pre-launch runner hash mismatch explained by a stale cache rather than a
 * binary swap (#7032): the extracted runner still hashes to a PREVIOUS
 * release's `runnerSha256`, or the startup prefetch that replaces it is still
 * in flight. Launch is still refused, but callers (the daemon's startup iOS
 * init) treat it as "defer to the first tool call" instead of a tampering
 * incident. `cachedVersion` is null when only the in-flight prefetch explains
 * the mismatch (the on-disk hash is not in the registry, e.g. a nightly).
 */
export class CtrlProxyStaleRunnerCacheError extends ActionableError {
  constructor(
    public readonly cachedVersion: string | null,
    public readonly expectedVersion: string,
  ) {
    super(
      `cached CtrlProxy runner is from ${cachedVersion ?? "an earlier release"}; ` +
        `waiting for the ${expectedVersion} bundle`,
    );
  }
}
