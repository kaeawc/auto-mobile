package dev.jasonpearson.automobile.desktop.domain

/**
 * The unit a geometry-bearing observation message expresses its coordinates in (issue #4550).
 *
 * The daemon declares this per message with a `coordinateSpace` field (issue #4549). There is
 * exactly ONE declared space — [Pixels] — and its absence is the legacy point-space fallback, so
 * this type is modelled as a nullable enum rather than as a two-valued one: `null` means "the
 * daemon did not declare a space", which is a different statement from "the daemon declared
 * points".
 *
 * A client MUST NOT infer pixels from silence. A pre-#4548 runner supplies no scale metadata, so
 * the daemon leaves its iOS hierarchy bounds in logical points against a pixel screenshot and
 * stamps nothing — the mixed-unit state canonical pixels replaced. Treating that as [Pixels] would
 * compare a 390-wide point-space root against a 1170-wide pixel frame and reject a perfectly good
 * frame.
 */
public enum class CoordinateSpace {
  /**
   * Canonical physical pixels in the current device orientation.
   *
   * Element `bounds`, the reported screen dimensions, and the screenshot's own pixels are all this
   * one unit, on both platforms: Android bounds are already physical pixels (`nativeScale` 1) and
   * the daemon multiplies iOS logical points by the runner-reported `nativeScale`. That is what
   * makes an EXACT absolute-dimension comparison meaningful — see [DeviceControlPolicy.evaluate].
   */
  Pixels;

  public companion object {
    /** The wire value the daemon stamps for [Pixels]. */
    public const val WIRE_PIXELS: String = "px"

    /**
     * Map a wire `coordinateSpace` value to this enum, or null when the field was absent.
     *
     * An UNRECOGNIZED value also maps to null. A future daemon that declares a space this client
     * does not know must degrade to the conservative legacy path, never be silently read as pixels.
     */
    public fun fromWire(value: String?): CoordinateSpace? =
      if (value == WIRE_PIXELS) Pixels else null
  }
}
