import { shellQuote } from "../utils/shellQuote";

/**
 * Device-shell script fragments shared by Android file batches (putAppFile app containers and
 * stageSharedStorage). A batch that overwrites an existing file saves its previous content first,
 * so a failed batch restores it instead of deleting it.
 */

/**
 * Copies `destination` to `backup` when it already exists as a regular file and prints `marker`
 * only if the copy succeeded. A missing destination prints nothing and succeeds.
 */
export function androidSaveBackupScript(
  destination: string,
  backup: string,
  marker: string,
): string {
  return (
    `{ if [ -f ${shellQuote(destination)} ]; then ` +
    `cp ${shellQuote(destination)} ${shellQuote(backup)} && echo ${marker}; fi; }`
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
