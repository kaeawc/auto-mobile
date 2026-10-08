import { promises as fsPromises, readdirSync, type Dirent } from "node:fs";

// Promisified fs functions
export const readFileAsync = fsPromises.readFile;
export const writeFileAsync = fsPromises.writeFile;
export const statAsync = fsPromises.stat;

// Additional promisified fs functions
export const unlinkAsync = fsPromises.unlink;

/**
 * Byte-order (UTF-16 code unit) comparison. Unlike `localeCompare` it does not depend on the
 * host locale or ICU data, so every platform sorts identically.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Directory listings come back in filesystem order (hash order on ext4, roughly alphabetical on
 * APFS/NTFS). Every internal listing goes through these helpers so callers, caches, hashes and
 * tests see one deterministic order on every platform. Raw `readdir`/`readdirSync` in `src/` is
 * forbidden outside this module by test/lint/sortedListingBoundary.test.ts.
 */
export async function sortedReaddir(dirPath: string): Promise<string[]> {
  return (await fsPromises.readdir(dirPath)).sort(compareCodeUnits);
}

export async function sortedReaddirEntries(dirPath: string): Promise<Dirent[]> {
  return (await fsPromises.readdir(dirPath, { withFileTypes: true })).sort((a, b) =>
    compareCodeUnits(a.name, b.name),
  );
}

export function sortedReaddirSync(dirPath: string): string[] {
  return readdirSync(dirPath).sort(compareCodeUnits);
}

export function sortedReaddirEntriesSync(dirPath: string): Dirent[] {
  return readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
    compareCodeUnits(a.name, b.name),
  );
}
