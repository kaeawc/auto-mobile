import path from "node:path";

/**
 * Provenance ledger for tool-output artifacts (issue #5917).
 *
 * The `automobile:tool-output/{artifactId}` resource must serve ONLY files the
 * {@link JsonToolOutputArtifactWriter} actually created. A filename-shape
 * allowlist alone (`SAFE_ARTIFACT_ID`) still serves a hostile, writer-shaped
 * sibling planted in a shared/misconfigured `--tool-outputs-dir`. The writer
 * records every artifact it issues here; the resource resolves the read path
 * from this ledger instead of re-deriving it from the client-supplied id.
 *
 * Because the opened path is a value the writer constructed — never the request
 * parameter — this also breaks the request→filesystem-sink dataflow that
 * CodeQL's temp-dir heuristics flag, so the O_NOFOLLOW handle read on top of it
 * is satisfied rather than ping-ponged (issue #5917 review).
 *
 * In-memory and bounded: the daemon is a single long-lived process, artifacts
 * are pruned by retention, and a lost ledger entry (eviction, daemon restart)
 * degrades to the existing "expired or pruned" response — never an unsafe read.
 */
export class ToolOutputArtifactLedger {
  // basename -> absolute path the writer wrote. Insertion order is recency order
  // (a re-record deletes then re-sets), so eviction drops the least-recent.
  private readonly issued = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1024) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /** Record an artifact the writer just created, keyed by its basename. */
  record(absolutePath: string): void {
    const filename = path.basename(absolutePath);
    this.issued.delete(filename);
    this.issued.set(filename, absolutePath);
    while (this.issued.size > this.maxEntries) {
      const oldest = this.issued.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.issued.delete(oldest);
    }
  }

  /** The absolute path the writer issued for this basename, or undefined. */
  resolve(filename: string): string | undefined {
    return this.issued.get(filename);
  }

  /** Drop an artifact (e.g. after retention prunes its file). */
  forget(absolutePath: string): void {
    this.issued.delete(path.basename(absolutePath));
  }

  clear(): void {
    this.issued.clear();
  }

  get size(): number {
    return this.issued.size;
  }
}

/**
 * Process-wide ledger shared between the writer (which records) and the
 * tool-output resource handler (which resolves). Both run in the same daemon
 * process, so a single module singleton is the shared provenance record.
 */
export const toolOutputArtifactLedger = new ToolOutputArtifactLedger();
