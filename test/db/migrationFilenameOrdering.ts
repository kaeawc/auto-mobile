/**
 * Guard for migration filename ordering (issue #2868, surfaced by the #2785
 * destructive-recovery audit).
 *
 * Kysely's `Migrator` + `FileMigrationProvider` applies migrations in lexical
 * filename order. Our convention is a `YYYY_MM_DD_NNN_description.ts` name,
 * where the `YYYY_MM_DD_NNN` prefix is the *explicit* ordering key. When two
 * migrations share that full prefix, their relative order is decided only by
 * the incidental alphabetical order of the trailing description — a rebase or
 * a new file inserted into the shared prefix can silently change apply order,
 * and `migrateToLatest()` throws `corrupted migrations` whenever an unexecuted
 * migration sorts before an executed one (wedging startup on populated DBs).
 *
 * Renaming the already-shipped colliding files is NOT safe: every populated
 * dev database has the old filenames recorded in `kysely_migration`, and a
 * rename makes Kysely treat the recorded name as missing and the new name as
 * pending → `corrupted migrations` → the (post-#2850) recovery path refuses on
 * a populated DB. So issue #2868 takes the disambiguate-going-forward
 * strategy: the historical collisions are frozen in
 * {@link GRANDFATHERED_PREFIX_COLLISIONS} and every NEW collision fails the
 * accompanying meta-test.
 *
 * This is a pure `(filenames) -> violations` function so it is unit-tested
 * with string fixtures (no filesystem) and then applied to the real
 * `src/db/migrations/` directory by the meta-test — both stay well under
 * 100ms.
 */

/**
 * Canonical migration filename shape: `YYYY_MM_DD_NNN_description.ts` with a
 * lowercase snake_case description. Capture group 1 is the full ordering
 * prefix (`YYYY_MM_DD_NNN`).
 */
export const MIGRATION_FILENAME_PATTERN =
  /^(\d{4}_\d{2}_\d{2}_\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.ts$/;

/**
 * Historical `YYYY_MM_DD_NNN` prefix collisions that shipped before this guard
 * existed. FROZEN — this list may only ever SHRINK (if a rename-aware history
 * rewrite ever lands, see issue #2868 option 1). Never add an entry: pick the
 * next free `NNN` for your date instead.
 *
 * Each entry maps a shared prefix to the exact (sorted) set of files that
 * legitimately share it. Adding a THIRD file to one of these prefixes is a new
 * violation, and removing/renaming a listed file without shrinking this map is
 * flagged as a stale entry so the allowlist ratchets down.
 */
export const GRANDFATHERED_PREFIX_COLLISIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "2026_01_03_000": Object.freeze([
      "2026_01_03_000_feature_flags.ts",
      "2026_01_03_000_test_executions.ts",
    ]),
    "2026_01_11_000": Object.freeze([
      "2026_01_11_000_installed_apps.ts",
      "2026_01_11_000_video_recording_highlights.ts",
    ]),
    "2026_01_27_000": Object.freeze([
      "2026_01_27_000_crash_anr_monitoring.ts",
      "2026_01_27_000_failures.ts",
    ]),
    "2026_07_03_000": Object.freeze([
      "2026_07_03_000_drop_redundant_device_indexes.ts",
      "2026_07_03_000_repair_datetime_now_defaults.ts",
    ]),
  });

export type MigrationFilenameRule =
  | "malformed-filename"
  | "prefix-collision"
  | "stale-grandfather-entry";

export interface MigrationFilenameViolation {
  rule: MigrationFilenameRule;
  /** The offending filename(s), sorted. */
  files: string[];
  /** Human-readable, actionable description of the violation. */
  message: string;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * Check a list of migration filenames (basenames, e.g. from `readdirSync`)
 * against the naming/ordering convention: canonical shape + no non-grandfathered
 * `YYYY_MM_DD_NNN` prefix collisions. Returns an empty array when clean.
 *
 * The allowlist ratchet lives in {@link findStaleGrandfatherEntries} so this
 * function stays meaningful for partial fixture lists.
 */
export function checkMigrationFilenames(
  filenames: readonly string[],
): MigrationFilenameViolation[] {
  const violations: MigrationFilenameViolation[] = [];
  const byPrefix = new Map<string, string[]>();

  for (const filename of filenames) {
    const match = MIGRATION_FILENAME_PATTERN.exec(filename);
    if (!match) {
      violations.push({
        rule: "malformed-filename",
        files: [filename],
        message:
          `Migration filename "${filename}" does not match the required ` +
          "`YYYY_MM_DD_NNN_description.ts` shape (lowercase snake_case description). " +
          "Kysely orders migrations lexically by filename, so every migration must " +
          "carry an explicit `YYYY_MM_DD_NNN` ordering prefix.",
      });
      continue;
    }
    const prefix = match[1];
    const group = byPrefix.get(prefix);
    if (group) {
      group.push(filename);
    } else {
      byPrefix.set(prefix, [filename]);
    }
  }

  for (const [prefix, group] of byPrefix) {
    if (group.length < 2) {
      continue;
    }
    const grandfathered = GRANDFATHERED_PREFIX_COLLISIONS[prefix];
    if (grandfathered && sameMembers(group, grandfathered)) {
      continue;
    }
    violations.push({
      rule: "prefix-collision",
      files: [...group].sort(),
      message:
        `Migrations share the ordering prefix "${prefix}": ${[...group].sort().join(", ")}. ` +
        "Within a shared prefix Kysely's apply order is decided only by the incidental " +
        "alphabetical order of the description, which makes `corrupted migrations` " +
        "startup failures easy to trip (issue #2868). Rename the NEW file to the next " +
        `free NNN sequence for its date (e.g. "${prefix.slice(0, 11)}${String(
          Number(prefix.slice(11)) + 1,
        ).padStart(3, "0")}_..."). Do NOT extend GRANDFATHERED_PREFIX_COLLISIONS and do ` +
        "NOT rename an already-shipped migration — populated DBs record executed " +
        "filenames in `kysely_migration`, so renames wedge startup.",
    });
  }

  return violations;
}

/**
 * The allowlist ratchet: every file named in
 * {@link GRANDFATHERED_PREFIX_COLLISIONS} must still exist in the migrations
 * directory. If one is renamed or removed, the corresponding entry must be
 * deleted so the historical exception only ever shrinks. Run this against the
 * FULL real directory listing (not partial fixtures).
 */
export function findStaleGrandfatherEntries(
  filenames: readonly string[],
): MigrationFilenameViolation[] {
  const violations: MigrationFilenameViolation[] = [];
  for (const [prefix, grandfathered] of Object.entries(GRANDFATHERED_PREFIX_COLLISIONS)) {
    const missing = grandfathered.filter((file) => !filenames.includes(file));
    if (missing.length > 0) {
      violations.push({
        rule: "stale-grandfather-entry",
        files: [...missing].sort(),
        message:
          `GRANDFATHERED_PREFIX_COLLISIONS["${prefix}"] lists file(s) that no longer ` +
          `exist: ${missing.join(", ")}. The allowlist is a one-way ratchet — remove ` +
          "the stale entry so the historical exception shrinks with the codebase.",
      });
    }
  }
  return violations;
}
