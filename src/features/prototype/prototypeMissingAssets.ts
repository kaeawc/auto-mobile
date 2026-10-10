/** What the one automatic repair of supplied-but-missing assets did. */
export type MissingAssetRepair =
  /** Re-uploaded once and re-sent; the device still reports them missing. */
  | { kind: "still-missing" }
  /** The re-upload or re-send did not complete; `reason` says why. */
  | { kind: "retry-failed"; reason: string };

export interface MissingAssetsWarningInput {
  /** Ids the device reported missing in the result that is being returned. */
  missing: readonly string[];
  /** Ids this call supplied sources for. */
  supplied: ReadonlySet<string>;
  /** What happened when the supplied-and-missing ids were retried, if they were. */
  repair?: MissingAssetRepair;
}

function quoted(ids: readonly string[]): string {
  return ids.map((id) => `'${id}'`).join(", ");
}

/**
 * The warning for a successful show whose device result still lists missing assets. It
 * separates ids the caller never supplied (upload them) from ids it did supply (the one automatic
 * retry did not help, so something is clearing them).
 */
export function missingAssetsWarning(input: MissingAssetsWarningInput): string {
  const unsupplied = input.missing.filter((id) => !input.supplied.has(id));
  const supplied = input.missing.filter((id) => input.supplied.has(id));
  const parts: string[] = [];
  if (unsupplied.length > 0) {
    parts.push(
      `The device has no copy of prototype asset(s) ${quoted(unsupplied)}, so those images show placeholders. Upload them with assets: [{id, path}] on a show.`,
    );
  }
  if (supplied.length > 0) {
    const detail =
      input.repair?.kind === "retry-failed"
        ? `the automatic re-upload did not complete: ${input.repair.reason}`
        : "they were re-uploaded and the prototype re-sent once, and the device still reports them missing";
    parts.push(
      `Asset(s) ${quoted(supplied)} were supplied on this call but the device reports them missing; ${detail}. Repeat the call to try again.`,
    );
  }
  return parts.join(" ");
}
