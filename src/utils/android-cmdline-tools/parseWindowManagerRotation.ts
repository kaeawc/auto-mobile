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
 *  - WindowManagerService itself prints the authoritative, live display
 *    rotation, but WHERE it prints it has changed across API levels:
 *      - API ~25-28 and ~34+: its own line, `mRotation=<digit>` (optionally
 *        followed by other top-level fields such as `mAltOrientation=false`),
 *        after indentation only.
 *      - API ~29-33: inline on the display-status line instead of its own
 *        line — `mDisplayFrozen=<bool> windows=<n> client=<bool> apps=<n>
 *        mRotation=<digit> ...` (see the
 *        `test/features/observe/windowDumps/api29..33-settings-window-dump.log`
 *        fixtures, and issue #6199).
 *
 * Both authoritative forms are accepted, distinguished by which line/context
 * they appear in — a bare `mRotation=<digit>` at line start, OR one inline on
 * the `mDisplayFrozen=` display-status line — while TaskSnapshot and
 * Configuration occurrences are still excluded either way, since neither of
 * those contains `mDisplayFrozen=` and neither starts a line with
 * `mRotation=`. See issue #6199.
 *
 * @param dumpsysWindowOutput - stdout of `dumpsys window` (or a filtered subset)
 * @returns The parsed rotation value (0-3), or null if the authoritative
 *   field was not found
 */
export function parseWindowManagerRotation(dumpsysWindowOutput: string): number | null {
  for (const line of dumpsysWindowOutput.split("\n")) {
    const trimmed = line.trim();

    // API ~25-28 and ~34+: WindowManagerService prints its own top-level
    // field as its own line.
    const standalone = trimmed.match(/^mRotation=(\d+)/);
    if (standalone) {
      return parseInt(standalone[1], 10);
    }

    // API ~29-33: the same authoritative field is printed inline on the
    // display-status line instead of getting its own line. `mDisplayFrozen=`
    // is WindowManagerService's own field name (never present in a
    // TaskSnapshot or Configuration toString), so anchoring to it keeps
    // those unrelated `mRotation=` occurrences excluded.
    if (trimmed.startsWith("mDisplayFrozen=")) {
      const inline = trimmed.match(/\bmRotation=(\d+)\b/);
      if (inline) {
        return parseInt(inline[1], 10);
      }
    }
  }
  return null;
}
