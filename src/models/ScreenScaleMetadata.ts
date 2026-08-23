/**
 * Runner-reported screen scale metadata (#4548, B1 of the canonical-pixel campaign
 * #4547 -> #4548 -> #4549 -> #4550).
 *
 * `nativeScale` is the ratio between the bounds units the runner reports in its hierarchies and
 * the physical pixels of its screenshots:
 * - iOS reports `UIScreen.nativeScale` — NOT `UIScreen.scale`. Under Display Zoom the two differ
 *   (scale stays 3.0 while nativeScale shifts, e.g. ~3.14 zoomed, ~2.61 on Plus downsampling
 *   panels) and `XCUIScreenshot.pngRepresentation` renders at native scale, so only nativeScale
 *   converts point bounds to screenshot pixels.
 * - Android hierarchy bounds and screenshots are both physical pixels, so it reports exactly 1.
 *
 * `pixelWidth`/`pixelHeight` are the physical screenshot pixel dimensions the runner derives from
 * that scale. The daemon RETAINS this metadata for #4549's canonical-pixel conversion; nothing in
 * current behavior consumes it, and hierarchies from pre-#4548 runners simply never populate it.
 */
export interface ScreenScaleMetadata {
  nativeScale: number;
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * Extract complete, well-formed scale metadata from a runner hierarchy message, or null when any
 * field is missing or degenerate (which is exactly what a pre-#4548 runner produces — the Android
 * runner serializes absent optionals as JSON null, so null and undefined both mean "absent").
 * All-or-nothing: partial metadata is unusable for unit conversion, so it is never retained.
 */
export function readScreenScaleMetadata(
  source:
    | {
        nativeScale?: number | null;
        pixelWidth?: number | null;
        pixelHeight?: number | null;
      }
    | null
    | undefined,
): ScreenScaleMetadata | null {
  if (!source) {
    return null;
  }
  const { nativeScale, pixelWidth, pixelHeight } = source;
  if (
    typeof nativeScale !== "number" ||
    !Number.isFinite(nativeScale) ||
    nativeScale <= 0 ||
    typeof pixelWidth !== "number" ||
    !Number.isFinite(pixelWidth) ||
    pixelWidth <= 0 ||
    typeof pixelHeight !== "number" ||
    !Number.isFinite(pixelHeight) ||
    pixelHeight <= 0
  ) {
    return null;
  }
  return { nativeScale, pixelWidth, pixelHeight };
}

/**
 * A spreadable object carrying the three metadata fields when — and only when — the whole tuple is
 * complete-finite-positive, and `{}` otherwise. Converters use this to attach the fields to a
 * `ViewHierarchyResult`, so the conversion path and the client retention path (`getScreenScaleMetadata`)
 * apply the SAME all-or-nothing acceptance rule from a single validator. Spreading `{}` for a
 * partial/degenerate/absent payload keeps pre-#4548 (and malformed) results byte-identical: the
 * three keys are omitted entirely rather than emitted as `undefined`.
 */
export function screenScaleMetadataSpread(
  source:
    | {
        nativeScale?: number | null;
        pixelWidth?: number | null;
        pixelHeight?: number | null;
      }
    | null
    | undefined,
): ScreenScaleMetadata | Record<string, never> {
  return readScreenScaleMetadata(source) ?? {};
}
