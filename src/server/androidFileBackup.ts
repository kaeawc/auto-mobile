import { shellQuote } from "../utils/shellQuote";

/**
 * Device-shell script fragments shared by Android file batches (putAppFile app containers and
 * sharedStorageService). A batch that overwrites an existing file saves its previous content first,
 * so a failed batch restores it instead of deleting it.
 */

/** The in-progress copy of a backup. The backup path itself only ever exists complete. */
export function androidBackupPartPath(backup: string): string {
  return `${backup}.part`;
}

/**
 * Copies `destination` to `backup` when it already exists as a regular file and prints `marker`
 * only if the copy succeeded. A missing destination prints nothing and succeeds.
 *
 * The copy goes to `<backup>.part` and is renamed into place, so `backup` only ever exists
 * complete: a failed or killed `cp` leaves the original untouched and at most a `.part`, which a
 * truncated copy can never turn into a "backup" that a rollback would move over the original.
 */
export function androidSaveBackupScript(
  destination: string,
  backup: string,
  marker: string,
): string {
  const part = androidBackupPartPath(backup);
  return (
    `{ if [ -f ${shellQuote(destination)} ]; then ` +
    `cp ${shellQuote(destination)} ${shellQuote(part)} && ` +
    `mv -f ${shellQuote(part)} ${shellQuote(backup)} && echo ${marker}; fi; }`
  );
}

/**
 * Failure cleanup for one saved destination whose outcome is unknown: removes the in-progress
 * `.part` and, only if a complete backup exists, moves it back over the destination. A partial
 * copy never reaches the backup path, so an intact destination is left alone; restoring a complete
 * backup is a no-op when the destination was never replaced.
 */
export function androidRestoreBackupScript(destination: string, backup: string): string {
  return (
    `rm -f ${shellQuote(androidBackupPartPath(backup))}; ` +
    `if [ -f ${shellQuote(backup)} ]; then mv -f ${shellQuote(backup)} ${shellQuote(destination)}; fi`
  );
}

/** Runs every step, exiting non-zero if any step failed (later steps still run). */
export function androidStepsScript(steps: string[]): string {
  return `rc=0; ${steps.map((step) => `${step} || rc=1`).join("; ")}; exit $rc`;
}

/**
 * Deletes newly created files and runs the restore steps, exiting non-zero if any step fails.
 * `created` entries are already shell-quoted paths; `restores` are complete shell commands.
 */
export function androidRollbackScript(created: string[], restores: string[]): string {
  return androidStepsScript([
    ...(created.length > 0 ? [`rm -f ${created.join(" ")}`] : []),
    ...restores,
  ]);
}

/**
 * Prints `<marker>:<index>:<bytes>` for each destination that exists as a regular file and
 * `<marker>:<index>:absent` for one that does not. A destination whose size cannot be read prints
 * nothing, so its size stays unknown. Always exits 0: the output alone carries the answer.
 */
export function androidExistingSizesScript(
  destinations: readonly string[],
  marker: string,
): string {
  const steps = destinations.map((destination, index) => {
    const quoted = shellQuote(destination);
    return (
      `if [ -f ${quoted} ]; then s=$(stat -c %s ${quoted} 2>/dev/null) && ` +
      `echo "${marker}:${index}:$s"; else echo "${marker}:${index}:absent"; fi`
    );
  });
  return `${steps.join("; ")}; exit 0`;
}

/**
 * Sizes from {@link androidExistingSizesScript} output, one entry per destination: the byte count,
 * 0 for an absent destination (nothing to copy), or `undefined` when the size is unknown.
 */
export function parseExistingSizes(
  stdout: string,
  count: number,
  marker: string,
): Array<number | undefined> {
  const sizes = new Array<number | undefined>(count).fill(undefined);
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(":");
    if (parts.length !== 3 || parts[0] !== marker) {
      continue;
    }
    const index = Number(parts[1]);
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      continue;
    }
    const value = parts[2] ?? "";
    const bytes = value === "absent" ? 0 : /^\d+$/.test(value) ? Number(value) : undefined;
    if (bytes !== undefined && Number.isSafeInteger(bytes)) {
      sizes[index] = bytes;
    }
  }
  return sizes;
}
