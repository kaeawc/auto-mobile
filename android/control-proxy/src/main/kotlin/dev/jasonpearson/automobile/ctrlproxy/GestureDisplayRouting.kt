package dev.jasonpearson.automobile.ctrlproxy

/** Narrow builder seam for fast tests without Android static mocks. */
internal fun interface GestureDisplayIdApplier {
  fun setDisplayId(displayId: Int)
}

internal object GestureDisplayRouting {
  private const val DISPLAY_API = 30

  fun error(displayId: Int?, sdkInt: Int): String? =
    when {
      displayId == null -> null
      displayId < 0 -> "displayId must be non-negative: $displayId"
      displayId != 0 && sdkInt < DISPLAY_API ->
        "Gesture display routing requires Android 11 (API 30)"
      else -> null
    }

  fun apply(displayId: Int?, sdkInt: Int, builder: GestureDisplayIdApplier) {
    require(error(displayId, sdkInt) == null) { error(displayId, sdkInt).orEmpty() }
    if (displayId != null && sdkInt >= DISPLAY_API) builder.setDisplayId(displayId)
  }
}
