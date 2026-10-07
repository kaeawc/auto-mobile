/**
 * Where a process generation token lives in a persisted/wire daemon record.
 *
 * The token itself is one opaque string whose prefix names its scheme
 * (`linux:`, `darwin-utc:`; the retired time-zone-dependent `darwin:` scheme is
 * still READ from records an older daemon wrote). The scheme decides the FIELD:
 *
 * - `processGenerationToken` is the field every daemon build since 0.0.77 reads
 *   with a strict `!==` against a token it computes itself
 *   (`daemonFiles.ts` `PidFileLiveDaemonSessionIdProvider.isConfirmedRecycledProcess`).
 *   A `darwin-utc:` value there can never equal the `darwin:<local time>` such a
 *   build computes, so it would be judged a recycled PID and the live daemon's
 *   device sessions expired by the starting build. The Linux scheme did not
 *   change, so Linux keeps this field and old and new readers still agree.
 * - `processGenerationTokenUtc` carries the zone-free Darwin token only. A build
 *   that predates it does not know the field, sees NO token, and takes its
 *   existing "no token: keep the peer, fall back to the birth-time rule" path.
 *
 * Kept free of imports so the live-acceptance capability module and every
 * record type can use it without a dependency cycle.
 */
export const DARWIN_UTC_PROCESS_GENERATION_PREFIX = "darwin-utc";

export interface ProcessGenerationRecordFields {
  /** Linux token, or a `darwin:` token written by an older build. Never `darwin-utc:`. */
  processGenerationToken?: string;
  /** Zone-free Darwin (`darwin-utc:`) token. Unknown to builds that predate it. */
  processGenerationTokenUtc?: string;
}

/** The record field(s) that publish `token`; spread into a PID record, status or RPC params. */
export function processGenerationRecordFields(
  token: string | undefined,
): ProcessGenerationRecordFields {
  if (token === undefined) {
    return {};
  }
  return token.startsWith(`${DARWIN_UTC_PROCESS_GENERATION_PREFIX}:`)
    ? { processGenerationTokenUtc: token }
    : { processGenerationToken: token };
}

/**
 * The token a record carries, from whichever field holds it. The zone-free field
 * wins; a record written by an older build only has the legacy one.
 */
export function recordedProcessGenerationToken(record: {
  processGenerationToken?: unknown;
  processGenerationTokenUtc?: unknown;
}): string | undefined {
  if (typeof record.processGenerationTokenUtc === "string") {
    return record.processGenerationTokenUtc;
  }
  return typeof record.processGenerationToken === "string"
    ? record.processGenerationToken
    : undefined;
}
