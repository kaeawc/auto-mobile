package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import java.io.File
import kotlin.math.ceil
import kotlin.math.sqrt

/**
 * A host-side prototype preview request (issue #10445): render each spec file off-device through
 * the production renderer and write one PNG per spec, plus a contact sheet when there is more than
 * one.
 *
 * Read from the `-Dprototype.preview.*` switches that `control-proxy/build.gradle.kts` forwards to
 * the test JVM, normally set by `scripts/prototype/preview.sh`:
 * - `prototype.preview.spec` — spec JSON files, separated by the platform path separator
 *   (required).
 * - `prototype.preview.out` — output directory (required).
 * - `prototype.preview.width` / `prototype.preview.height` — the surface the prototype lays out in,
 *   in dp (default 360 x 640). The PNG is the prototype content's own bounds, which may be smaller.
 * - `prototype.preview.density` — screen density in dpi (default 160, so 1 dp = 1 px).
 * - `prototype.preview.theme` — `light` or `dark` device night mode (default `light`). A spec whose
 *   theme mode is `light` or `dark` still decides for itself; this only drives `system`.
 */
internal data class PrototypePreviewRequest(
  val specs: List<File>,
  val outputDir: File,
  val widthDp: Int = DEFAULT_WIDTH_DP,
  val heightDp: Int = DEFAULT_HEIGHT_DP,
  val densityDpi: Int = DEFAULT_DENSITY_DPI,
  val theme: Theme = Theme.LIGHT,
) {
  init {
    require(specs.isNotEmpty()) { "A prototype preview needs at least one spec" }
    val clashes = specs.groupBy { outputFor(it).name }.filterValues { it.size > 1 }.keys
    require(clashes.isEmpty()) {
      "Prototype preview specs would overwrite each other's PNG: $clashes"
    }
  }

  enum class Theme(val qualifier: String) {
    LIGHT("notnight"),
    DARK("night"),
  }

  /** Robolectric qualifiers for the requested surface, in Android's canonical qualifier order. */
  val qualifiers: String
    get() = "w${widthDp}dp-h${heightDp}dp-${theme.qualifier}-${densityDpi}dpi"

  /** The PNG written for [spec]: its file name with `.json` replaced by `.png`. */
  fun outputFor(spec: File): File = File(outputDir, "${spec.name.removeSuffix(".json")}.png")

  val contactSheet: File
    get() = File(outputDir, CONTACT_SHEET_NAME)

  companion object {
    const val SPEC_PROPERTY = "prototype.preview.spec"
    const val OUT_PROPERTY = "prototype.preview.out"
    const val WIDTH_PROPERTY = "prototype.preview.width"
    const val HEIGHT_PROPERTY = "prototype.preview.height"
    const val DENSITY_PROPERTY = "prototype.preview.density"
    const val THEME_PROPERTY = "prototype.preview.theme"
    const val CONTACT_SHEET_NAME = "contact-sheet.png"

    const val DEFAULT_WIDTH_DP = 360
    const val DEFAULT_HEIGHT_DP = 640
    const val DEFAULT_DENSITY_DPI = 160
    private const val MAX_SIZE_DP = 4096
    private val DENSITY_RANGE = 72..800

    /**
     * Parses a request from [property] lookups, or returns null when no spec was requested so the
     * preview test can skip. Malformed values throw [IllegalArgumentException] naming the switch.
     */
    fun fromProperties(
      property: (String) -> String?,
      pathSeparator: String = File.pathSeparator,
    ): PrototypePreviewRequest? {
      val specs =
        property(SPEC_PROPERTY)
          ?.split(pathSeparator)
          ?.map(String::trim)
          ?.filter(String::isNotEmpty)
          .orEmpty()
      if (specs.isEmpty()) return null
      val out = property(OUT_PROPERTY)?.trim().orEmpty()
      require(out.isNotEmpty()) { "-D$OUT_PROPERTY is required with -D$SPEC_PROPERTY" }
      return PrototypePreviewRequest(
        specs = specs.map(::File),
        outputDir = File(out),
        widthDp = intProperty(property, WIDTH_PROPERTY, DEFAULT_WIDTH_DP, 1..MAX_SIZE_DP),
        heightDp = intProperty(property, HEIGHT_PROPERTY, DEFAULT_HEIGHT_DP, 1..MAX_SIZE_DP),
        densityDpi = intProperty(property, DENSITY_PROPERTY, DEFAULT_DENSITY_DPI, DENSITY_RANGE),
        theme = themeProperty(property(THEME_PROPERTY)),
      )
    }

    private fun intProperty(
      property: (String) -> String?,
      key: String,
      default: Int,
      range: IntRange,
    ): Int {
      val raw = property(key)?.trim()?.takeIf(String::isNotEmpty) ?: return default
      val value = raw.toIntOrNull()
      require(value != null && value in range) {
        "-D$key must be an integer in ${range.first}..${range.last}, got '$raw'"
      }
      return value
    }

    private fun themeProperty(raw: String?): Theme {
      val value = raw?.trim()?.lowercase()?.takeIf(String::isNotEmpty) ?: return Theme.LIGHT
      return Theme.entries.firstOrNull { it.name.lowercase() == value }
        ?: throw IllegalArgumentException("-D$THEME_PROPERTY must be light or dark, got '$raw'")
    }
  }
}

/**
 * Lays [images] out left to right, top to bottom, in a near-square grid of equal cells (the largest
 * image's size) separated and framed by [gutter] pixels of [background]. Each image is drawn at the
 * top-left of its cell, unscaled.
 */
internal fun prototypeContactSheet(
  images: List<PrototypeScreenshotComparator.Image>,
  gutter: Int = 16,
  background: Int = 0xFF808080.toInt(),
): PrototypeScreenshotComparator.Image {
  require(images.isNotEmpty()) { "A contact sheet needs at least one image" }
  require(gutter >= 0) { "gutter must not be negative, got $gutter" }
  val columns = ceil(sqrt(images.size.toDouble())).toInt()
  val rows = (images.size + columns - 1) / columns
  val cellWidth = images.maxOf { it.width }
  val cellHeight = images.maxOf { it.height }
  val width = columns * cellWidth + (columns + 1) * gutter
  val height = rows * cellHeight + (rows + 1) * gutter
  val pixels = IntArray(width * height) { background }
  images.forEachIndexed { index, image ->
    val left = gutter + (index % columns) * (cellWidth + gutter)
    val top = gutter + (index / columns) * (cellHeight + gutter)
    for (y in 0 until image.height) {
      System.arraycopy(image.pixels, y * image.width, pixels, (top + y) * width + left, image.width)
    }
  }
  return PrototypeScreenshotComparator.Image(width, height, pixels)
}
