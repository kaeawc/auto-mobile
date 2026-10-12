package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeAppearance
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceMode
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceOverride
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceSource
import dev.jasonpearson.automobile.protocol.PrototypeSpecTheme

/**
 * The device's own appearance, read by the controller whenever it resolves a shown prototype. The
 * controller, not each window's Compose configuration, is the one reader, so every window of a show
 * (the service context's and any display or app-layer window context's) follows the same value.
 */
interface PrototypeDeviceAppearance {
  /** Whether the device is in night mode. */
  val dark: Boolean

  /**
   * Identifies the device's dynamic-colour palette. A different value means the wallpaper or
   * palette changed, so a `colors.source: "device"` scheme must be read again. Constant where the
   * OS has no dynamic colour.
   */
  val paletteKey: Int
}

/** A light device with no dynamic colour: the controller's default outside the service. */
object NoPrototypeDeviceAppearance : PrototypeDeviceAppearance {
  override val dark = false
  override val paletteKey = 0
}

/**
 * Reads the service context, whose configuration the platform updates before
 * `onConfigurationChanged`. The palette key hashes one tone of each Material You palette (API 31+).
 */
class AndroidPrototypeDeviceAppearance(
  private val context: Context,
  private val sdkInt: Int = Build.VERSION.SDK_INT,
) : PrototypeDeviceAppearance {
  override val dark: Boolean
    get() =
      (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES

  override val paletteKey: Int
    @SuppressLint("NewApi")
    get() =
      if (sdkInt < Build.VERSION_CODES.S) 0
      else
        try {
          PALETTE_TONES.fold(0) { key, tone -> 31 * key + context.getColor(tone) }
        } catch (error: Exception) {
          // Best-effort: an unreadable palette keeps the scheme already drawn.
          Log.w("PrototypeAppearance", "Device palette unavailable", error)
          0
        }

  private companion object {
    @SuppressLint("InlinedApi")
    val PALETTE_TONES =
      listOf(
        android.R.color.system_accent1_500,
        android.R.color.system_accent2_500,
        android.R.color.system_accent3_500,
        android.R.color.system_neutral1_500,
        android.R.color.system_neutral2_500,
      )
  }
}

/**
 * What one show is themed from. The controller owns it and updates it when the live tree, the
 * device setting or the device palette changes; host chrome, scrims, content, images and window
 * metadata all read this one value, so they can never resolve different modes (#11221). [root] is
 * the live render root (current pager pages and `styleWhen` states), not the tree as it was first
 * shown.
 */
data class PrototypeShownTheme(
  val root: PrototypeRenderNode,
  val specTheme: PrototypeSpecTheme?,
  val appearance: PrototypeAppearance,
  val paletteKey: Int = 0,
)

internal val PrototypeAppearance.dark: Boolean
  get() = mode == PrototypeAppearanceMode.DARK

/**
 * The one resolution order (#11215 D4): an explicit `theme.mode` of `light` or `dark`; then, when
 * the mode is absent, the luminance of the flat `background`/`surface` role override, then the
 * first opaque authored background on the root chain; and last the system setting. `mode: "system"`
 * goes straight to the system setting. [override] stands in for the system setting only: it never
 * beats an explicit mode or a screen colour the author painted.
 */
internal fun prototypeResolveAppearance(
  root: PrototypeRenderNode,
  explicit: PrototypeSpecTheme?,
  deviceDark: Boolean,
  override: PrototypeAppearanceOverride? = null,
): PrototypeAppearance {
  val pinned =
    when (override) {
      PrototypeAppearanceOverride.LIGHT -> false
      PrototypeAppearanceOverride.DARK -> true
      PrototypeAppearanceOverride.DEVICE,
      null -> null
    }
  val system =
    (pinned ?: deviceDark) to
      if (pinned != null) PrototypeAppearanceSource.OVERRIDE else PrototypeAppearanceSource.SYSTEM
  val (dark, source) =
    when (explicit?.mode) {
      "light" -> false to PrototypeAppearanceSource.EXPLICIT
      "dark" -> true to PrototypeAppearanceSource.EXPLICIT
      "system" -> system
      else ->
        prototypeRoleSurfaceDark(explicit?.colors)?.let {
          it to PrototypeAppearanceSource.ROLE_LUMINANCE
        }
          ?: prototypeAuthoredTheme(root)?.let {
            it.dark to PrototypeAppearanceSource.AUTHORED_BACKGROUND
          }
          ?: system
    }
  return PrototypeAppearance(
    if (dark) PrototypeAppearanceMode.DARK else PrototypeAppearanceMode.LIGHT,
    source,
    deviceDark,
  )
}

/**
 * The palette [shown] is drawn with. Device dynamic colour is left out, as in
 * [prototypeReachablePalettes]: its roles are opaque like the baseline ones.
 */
internal fun prototypeShownPalette(shown: PrototypeShownTheme): PrototypePalette {
  val dark = shown.appearance.dark
  return PrototypePalette(
    prototypeColorScheme(prototypeThemeSpecFor(shown.root, shown.specTheme, dark)),
    dark,
  )
}
