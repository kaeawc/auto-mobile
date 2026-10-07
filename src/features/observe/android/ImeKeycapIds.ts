/**
 * The resource-id shapes that identify a soft keyboard's keys. Shared by the
 * skeleton's `<ime>` fold and by the element resolver, so the keys `observe`
 * hides are exactly the keys a selector may not hit (issue #10225).
 */

/**
 * The `…:id/key_pos_*` resource-id family every AOSP/Gboard-derived IME gives
 * its keycaps. The suffix is NOT a `<row>_<col>` grid coordinate — the captured
 * Gboard fixtures under `test/fixtures/observe/diff/` carry `key_pos_shift`,
 * `key_pos_space`, `key_pos_del`, `key_pos_ime_action` and
 * `key_pos_header_access_points_menu` alongside positional ones — so the prefix
 * is all that can be matched, and corroboration has to come from
 * {@link MIN_FALLBACK_KEYCAPS} rather than from the suffix shape.
 *
 * This is the FALLBACK identification path (issue #6871): the authoritative one
 * is the control proxy's `automobile:imePackage` window extra (surfaced on
 * `ElementProvenance.keyboardPackage`) — but that extra only exists on a re-cut
 * control proxy, so on an older on-device build (and on the `uiautomator dump`
 * path) the ~40 keycaps still reached the skeleton. The capture group is the
 * IME's own package, which is also what distinguishes a keycap from the
 * framework chrome that shares the window (`android:id/input_method_nav_back`).
 */
export const KEYCAP_ID_PATTERN = /^([A-Za-z0-9_.]+):id\/key_pos_/;

/**
 * How many DISTINCT `key_pos_*` resource-ids one package must own before the
 * fallback path is willing to call it a keyboard (issue #6871).
 *
 * Without this fence a single app control that merely borrows the prefix
 * (`com.app:id/key_pos_preview`) was conclusive evidence on a screen with no
 * keyboard at all: its own row was folded away, `keyboard` announced
 * `{ visible: true, package: "com.app" }`, and a synthetic `<ime>` row appeared
 * for a keyboard that was never up. Nothing authoritative exists on that path to
 * override the false marker, so the corroboration has to come from the markers
 * themselves — a keyboard is a grid of keys and always presents many, while a
 * borrowed prefix is one node. Two is the smallest threshold that rejects the
 * lone decoy; the real captures carry eight or more.
 */
export const MIN_FALLBACK_KEYCAPS = 2;

/** The `package` half of a canonical `package:id/name` Android resource-id. */
export const RESOURCE_ID_PACKAGE_PATTERN = /^([A-Za-z0-9_.]+):id\//;

/** The owning package of a `package:id/name` resource-id, when it has that shape. */
export function resourceIdPackage(resourceId: string | undefined): string | undefined {
  return RESOURCE_ID_PACKAGE_PATTERN.exec(resourceId ?? "")?.[1];
}

/**
 * Whether a node inside the IME window collapses into the single `<ime>` row.
 * A node whose resource-id belongs to a DIFFERENT package than the IME is
 * framework chrome sharing the window (`android:id/input_method_nav_back`) and
 * stays individually actionable (issue #6871). Anything the IME owns, or that
 * carries no package-qualified id, is a key.
 */
export function isImeOwnedId(
  resourceId: string | undefined,
  imePackage: string | undefined,
): boolean {
  const owner = resourceIdPackage(resourceId);
  return owner === undefined || imePackage === undefined || owner === imePackage;
}
