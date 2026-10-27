import { createHash } from "node:crypto";
import { compareCodeUnits } from "./attestationSchema";

/** One tracked input file: where it is, what it holds, and its file mode. */
export interface InputEntry {
  path: string;
  id: string;
  mode: string;
}

/**
 * Shared normalization applied before any tier hashes its inputs (#11975): non-canonical inputs
 * are the main cause of "same work, different hash". When unsure whether something is an input,
 * include it; an over-inclusive hash costs a cache miss, an under-inclusive one a false skip.
 */
export function canonicalInputPath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new Error(`input path escapes the repository: ${path}`);
    }
    parts.push(part);
  }
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || parts.length === 0) {
    throw new Error(`input path is not repository-relative: ${path}`);
  }
  return parts.join("/");
}

/** Repository-relative paths, sorted by UTF-16 code unit, with duplicates refused. */
export function canonicalInputEntries(entries: readonly InputEntry[]): InputEntry[] {
  const canonical = entries
    .map(({ path, id, mode }) => ({ path: canonicalInputPath(path), id, mode }))
    .sort((a, b) => compareCodeUnits(a.path, b.path));
  for (let index = 1; index < canonical.length; index++) {
    if (canonical[index]!.path === canonical[index - 1]!.path) {
      throw new Error(`duplicate input path: ${canonical[index]!.path}`);
    }
  }
  return canonical;
}

/**
 * The named environment variables that a tier's tasks read, sorted by name; an unset variable is
 * recorded as such, so setting it changes the hash. Names outside the list never matter.
 */
export function canonicalEnvironmentInputs(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Array<[string, string | null]> {
  return [...new Set(names)]
    .sort(compareCodeUnits)
    .map((name): [string, string | null] => [name, env[name] ?? null]);
}

/** Line endings pinned to LF, so a text input read on any host hashes the same. */
export function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/** sha256 over one JSON line per record, in the order given; callers sort first. */
export function hashRecords(algorithm: string, records: readonly unknown[]): string {
  const hash = createHash("sha256");
  hash.update(`${JSON.stringify(algorithm)}\n`);
  for (const record of records) {
    hash.update(`${JSON.stringify(record)}\n`);
  }
  return hash.digest("hex");
}
