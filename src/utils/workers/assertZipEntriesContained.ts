import * as path from "node:path";
import type AdmZip from "adm-zip";
import { ActionableError } from "../../models/ActionableError";

/**
 * Defensive zip-slip containment check (issue #4761). adm-zip >= 0.5.10 already
 * sanitizes entry names in `extractAllTo` (`canonical` + `sanitize`), but this
 * bundle only reaches extraction on the unverified fallback/override paths, so a
 * malicious archive is worth a second, explicit gate: reject any entry that
 * resolves outside the destination BEFORE writing a single file. Belt-and-braces
 * on top of the library guard, independent of the installed adm-zip version.
 */
export function assertZipEntriesContained(zip: AdmZip, destination: string): void {
  const resolvedRoot = path.resolve(destination);
  for (const entry of zip.getEntries()) {
    const target = path.resolve(resolvedRoot, entry.entryName);
    const relative = path.relative(resolvedRoot, target);
    const escapes =
      relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (escapes) {
      throw new ActionableError(
        `Refusing to extract CtrlProxy bundle: entry "${entry.entryName}" resolves outside the ` +
          `extraction directory ${resolvedRoot} (zip-slip / path traversal).`,
      );
    }
  }
}
