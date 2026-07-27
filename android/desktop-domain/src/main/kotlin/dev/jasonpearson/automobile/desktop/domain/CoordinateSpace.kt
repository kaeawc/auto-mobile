package dev.jasonpearson.automobile.desktop.domain

/**
 * The unit a geometry-bearing observation message expresses its coordinates in (issue #4550).
 *
 * The daemon declares this per message with a `coordinateSpace` field (issue #4549). Three states
 * are distinguishable, and every distinction is load-bearing:
 * - [Pixels] — declared `"px"`, canonical physical pixels. Absolute dimensions compare exactly, and
 *   input coordinates are sent in the same unit.
 * - [Unrecognized] — a space was DECLARED, but this client does not implement it. Control fails
 *   closed; see below.
 * - `null` — no declaration at all. The LEGACY point-space fallback, and the only state that keeps
 *   the aspect-only geometry check.
 *
 * A client must not infer pixels from silence. A pre-#4548 runner supplies no scale metadata, so
 * the daemon leaves its iOS hierarchy bounds in logical points against a pixel screenshot and
 * stamps nothing — the mixed-unit state canonical pixels replaced. Treating that as [Pixels] would
 * compare a 390-wide point-space root against a 1170-wide pixel frame and reject a perfectly good
 * frame.
 *
 * Nor may it collapse [Unrecognized] into that same `null`. "Absent" is a state this client
 * understands completely: it knows what a legacy daemon's geometry means and what unit its input
 * endpoints expect. "Declared something else" is a state it understands nothing about — neither the
 * geometry semantics nor the input unit — so acting on such a frame would forward a coordinate
 * whose meaning is unknown to real hardware. Keeping them distinct is also what makes a
 * legacy-to-unknown transition visible to the retained-frame guard in `DeviceControlSession`:
 * collapsed to `null`, both sides would compare equal and the transition would pass unnoticed.
 */
public sealed interface CoordinateSpace {

  /**
   * Canonical physical pixels in the current device orientation.
   *
   * Element `bounds`, the reported screen dimensions, and the screenshot's own pixels are all this
   * one unit, on both platforms: Android bounds are already physical pixels (`nativeScale` 1) and
   * the daemon multiplies iOS logical points by the runner-reported `nativeScale`. That is what
   * makes an EXACT absolute-dimension comparison meaningful — see [DeviceControlPolicy.evaluate].
   */
  public data object Pixels : CoordinateSpace

  /**
   * A space this client does not implement, carrying the declared value verbatim so a caller can
   * report what it actually saw.
   *
   * Reached only when a daemon declares a space newer than this client. Control is blocked with
   * [DeviceControlBlockReason.UnsupportedCoordinateSpace] rather than degraded: a
   * forward-compatibility failure should look like "this client is too old", never like a silent
   * reinterpretation of coordinates.
   */
  public data class Unrecognized(val wireValue: String) : CoordinateSpace

  public companion object {
    /** The wire value the daemon stamps for [Pixels]. */
    public const val WIRE_PIXELS: String = "px"

    /**
     * Map a wire `coordinateSpace` value: `null` stays `null` (absent — legacy), `"px"` becomes
     * [Pixels], and anything else becomes [Unrecognized] rather than being flattened into the
     * legacy state.
     */
    public fun fromWire(value: String?): CoordinateSpace? =
      when (value) {
        null -> null
        WIRE_PIXELS -> Pixels
        else -> Unrecognized(value)
      }
  }
}
