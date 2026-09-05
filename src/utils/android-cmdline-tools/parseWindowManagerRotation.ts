/**
 * Parse the authoritative WindowManagerService display rotation out of
 * `dumpsys window` output (or a `grep -i "mRotation="`-filtered subset of it).
 *
 * `mRotation=` appears in several unrelated places in a real dump, and a
 * naive "first match" scan can pick the wrong one:
 *  - A cached `SnapshotCache` entry embeds a historical
 *    `snapshot=TaskSnapshot{... mRotation=<digit> ...}` — the rotation the
 *    task was captured at, which can be stale relative to the live display.
 *  - A window's `Configuration` toString embeds
 *    `winConfig={... mRotation=ROTATION_0}` — a symbolic (non-numeric) value.
 *  - WindowManagerService itself prints its own top-level field as its own
 *    line, `mRotation=<digit>` (optionally followed by other top-level
 *    fields such as `mAltOrientation=false`), after indentation only. This
 *    is the authoritative, live display rotation.
 *
 * Only the third form is accepted: this scans line by line and matches only
 * a line whose trimmed content starts with `mRotation=<digit>`, skipping any
 * `mRotation=` occurrence embedded inside a longer line (TaskSnapshot,
 * Configuration, etc). See issue #6199.
 *
 * @param dumpsysWindowOutput - stdout of `dumpsys window` (or a filtered subset)
 * @returns The parsed rotation value (0-3), or null if the authoritative
 *   field was not found
 */
export function parseWindowManagerRotation(dumpsysWindowOutput: string): number | null {
  for (const line of dumpsysWindowOutput.split("\n")) {
    const match = line.trim().match(/^mRotation=(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}
