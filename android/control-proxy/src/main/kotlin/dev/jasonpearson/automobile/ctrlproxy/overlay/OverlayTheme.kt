package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.content.Context
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import dev.jasonpearson.automobile.protocol.OverlaySpecTheme

/**
 * The overlay's own Material scheme: the window has no app theme, so without one every Material
 * component falls back to the baseline light palette whatever the spec draws (#10434).
 */
internal data class OverlayThemeSpec(
  val dark: Boolean,
  val surface: Color?,
  /** Seed colour a full scheme is generated from; null keeps the baseline palette. */
  val seed: Color? = null,
  /** The spec asked for device dynamic colour; honoured only when the OS supports it. */
  val dynamicColor: Boolean = false,
)

/**
 * The first opaque background on the tree's leading chain (root, then its first visible child, and
 * so on; hidden nodes paint nothing and are skipped) is what the author painted the screen with;
 * whichever of light or dark content reads better on it decides light or dark. A spec with no such
 * background follows the device setting. An explicit spec `theme` wins over this inference: its
 * `mode` decides light or dark, and its colours replace the background-derived surfaces (#10438).
 */
internal fun overlayThemeSpec(
  root: OverlayRenderNode,
  systemDark: Boolean,
  explicit: OverlaySpecTheme? = null,
): OverlayThemeSpec {
  val authored = overlayAuthoredTheme(root)
  val dark = overlayExplicitDark(explicit?.mode, systemDark) ?: authored?.dark ?: systemDark
  val seed = explicit?.colors?.seed?.let(::overlayColor)
  val dynamic = explicit?.colors?.source == DEVICE_COLOR_SOURCE
  // Authored surfaces only match a scheme of the same polarity, and never override explicit
  // colours.
  val surface = authored?.surface?.takeIf { seed == null && !dynamic && authored.dark == dark }
  return OverlayThemeSpec(dark, surface, seed, dynamic)
}

/** `light`/`dark` decide outright, `system` follows the device, and null means "not specified". */
private fun overlayExplicitDark(mode: String?, systemDark: Boolean): Boolean? =
  when (mode) {
    "light" -> false
    "dark" -> true
    "system" -> systemDark
    else -> null
  }

/** The theme the author painted, or null when the spec paints no opaque background. */
internal fun overlayAuthoredTheme(root: OverlayRenderNode): OverlayThemeSpec? {
  var node: OverlayRenderNode? = root
  while (node != null) {
    val background = node.style.background
    if (node.visible && background != null && background.alpha >= OPAQUE_BACKGROUND_ALPHA)
      return OverlayThemeSpec(background.luminance() < DARK_LUMINANCE_CEILING, background)
    node =
      if (node.role == "pager") node.children.getOrNull(node.page)
      else node.children.firstOrNull { it.visible }
  }
  return null
}

/**
 * Whether the host chrome (the dismiss control) should draw dark, or null to follow the device. An
 * explicit mode wins over the authored background: `light`/`dark` decide outright and `system`
 * follows the device, as the content scheme does. Only an absent mode infers from the background.
 */
internal fun overlayHostDark(model: OverlayRenderModel): Boolean? =
  when (model.theme?.mode) {
    "light" -> false
    "dark" -> true
    "system" -> null
    else -> overlayAuthoredTheme(model.root)?.dark
  }

/**
 * [dynamicScheme] is the device's Material You scheme, supplied only on API 31+. It is used when
 * the spec asked for device colour; otherwise a seed generates the scheme, else the baseline
 * palette is used with the authored surface painted over it.
 */
internal fun overlayColorScheme(
  theme: OverlayThemeSpec,
  dynamicScheme: ColorScheme? = null,
): ColorScheme {
  if (theme.dynamicColor && dynamicScheme != null) return dynamicScheme
  theme.seed?.let {
    return overlaySeedColorScheme(it, theme.dark)
  }
  val base = if (theme.dark) darkColorScheme() else lightColorScheme()
  val surface = theme.surface ?: return base
  return base.copy(
    background = surface,
    surface = surface,
    surfaceContainer = surface,
    surfaceContainerLow = surface,
    surfaceContainerHigh = surface,
    surfaceContainerHighest = surface,
  )
}

/**
 * A Material 3 style scheme from one colour. This is an HSL approximation of tonal palettes (no HCT
 * dependency): primary keeps the seed's hue and saturation, secondary is a muted version of it,
 * tertiary is rotated 60 degrees, and neutrals carry a trace of the hue. Tones follow the Material
 * light (primary 40, containers 90) and dark (primary 80, containers 30) assignments.
 */
internal fun overlaySeedColorScheme(seed: Color, dark: Boolean): ColorScheme {
  val (hue, seedSaturation) = seed.hueAndSaturation()
  // A grey seed stays grey; only a coloured one is clamped into a usable range.
  val chroma =
    if (seedSaturation == 0f) 0f
    else seedSaturation.coerceIn(SEED_MIN_SATURATION, SEED_MAX_SATURATION)

  fun tone(h: Float, s: Float, light: Float, darkTone: Float) =
    Color.hsl(h.mod(DEGREES), s.coerceIn(0f, 1f), if (dark) darkTone else light)

  val neutral = NEUTRAL_SATURATION
  val surface = tone(hue, neutral, 0.98f, 0.07f)

  // HSL lightness is not perceptual: a bright seed such as yellow lands at a fixed tone with almost
  // no contrast. Walk the accent away from the surface until it is legible on it.
  fun accent(h: Float, s: Float): Color {
    val step = if (dark) ACCENT_STEP else -ACCENT_STEP
    var lightness = if (dark) 0.80f else 0.40f
    var color = Color.hsl(h.mod(DEGREES), s.coerceIn(0f, 1f), lightness)
    while (
      color.contrastWith(surface) < MIN_ACCENT_CONTRAST &&
        lightness + step in ACCENT_MIN_LIGHTNESS..ACCENT_MAX_LIGHTNESS
    ) {
      lightness += step
      color = Color.hsl(h.mod(DEGREES), s.coerceIn(0f, 1f), lightness)
    }
    return color
  }

  // The content colour for a role is whichever of a light or dark tone reads better on it.
  fun onRole(role: Color, h: Float, s: Float): Color {
    val light = Color.hsl(h.mod(DEGREES), s.coerceIn(0f, 1f), 0.98f)
    val darkOn = Color.hsl(h.mod(DEGREES), s.coerceIn(0f, 1f), 0.04f)
    return if (role.contrastWith(light) >= role.contrastWith(darkOn)) light else darkOn
  }

  val secondaryChroma = chroma * 0.35f
  val tertiaryHue = hue + TERTIARY_HUE_ROTATION
  val tertiaryChroma = chroma * 0.6f
  val primary = accent(hue, chroma)
  val secondary = accent(hue, secondaryChroma)
  val tertiary = accent(tertiaryHue, tertiaryChroma)
  val primaryContainer = tone(hue, chroma, 0.90f, 0.30f)
  val secondaryContainer = tone(hue, secondaryChroma, 0.90f, 0.30f)
  val tertiaryContainer = tone(tertiaryHue, tertiaryChroma, 0.90f, 0.30f)
  return (if (dark) darkColorScheme() else lightColorScheme()).copy(
    primary = primary,
    onPrimary = onRole(primary, hue, chroma),
    primaryContainer = primaryContainer,
    onPrimaryContainer = onRole(primaryContainer, hue, chroma),
    secondary = secondary,
    onSecondary = onRole(secondary, hue, secondaryChroma),
    secondaryContainer = secondaryContainer,
    onSecondaryContainer = onRole(secondaryContainer, hue, secondaryChroma),
    tertiary = tertiary,
    onTertiary = onRole(tertiary, tertiaryHue, tertiaryChroma),
    tertiaryContainer = tertiaryContainer,
    onTertiaryContainer = onRole(tertiaryContainer, tertiaryHue, tertiaryChroma),
    background = surface,
    onBackground = tone(hue, neutral, 0.10f, 0.90f),
    surface = surface,
    onSurface = tone(hue, neutral, 0.10f, 0.90f),
    surfaceVariant = tone(hue, neutral * 2, 0.90f, 0.25f),
    onSurfaceVariant = tone(hue, neutral * 2, 0.30f, 0.80f),
    surfaceContainerLowest = tone(hue, neutral, 1.00f, 0.04f),
    surfaceContainerLow = tone(hue, neutral, 0.96f, 0.10f),
    surfaceContainer = tone(hue, neutral, 0.94f, 0.12f),
    surfaceContainerHigh = tone(hue, neutral, 0.92f, 0.17f),
    surfaceContainerHighest = tone(hue, neutral, 0.90f, 0.22f),
    outline = tone(hue, neutral * 2, 0.46f, 0.60f),
    outlineVariant = tone(hue, neutral * 2, 0.80f, 0.30f),
  )
}

/** WCAG contrast ratio between two opaque colours. */
internal fun Color.contrastWith(other: Color): Float {
  val a = luminance()
  val b = other.luminance()
  return (maxOf(a, b) + 0.05f) / (minOf(a, b) + 0.05f)
}

/** Hue in degrees [0, 360) and HSL saturation [0, 1]. */
private fun Color.hueAndSaturation(): Pair<Float, Float> {
  val max = maxOf(red, green, blue)
  val min = minOf(red, green, blue)
  val delta = max - min
  if (delta == 0f) return 0f to 0f
  val lightness = (max + min) / 2f
  val saturation = delta / (1f - kotlin.math.abs(2f * lightness - 1f))
  val sector =
    when (max) {
      red -> ((green - blue) / delta).mod(6f)
      green -> (blue - red) / delta + 2f
      else -> (red - green) / delta + 4f
    }
  return sector * 60f to saturation
}

/** Translucent host dismiss colours for a scheme: quiet, but readable over any prototype. */
internal data class OverlayDismissColors(val background: Color, val content: Color)

internal fun overlayDismissColors(dark: Boolean): OverlayDismissColors =
  if (dark) OverlayDismissColors(Color(0x99000000), Color(0xFFE6E6E6))
  else OverlayDismissColors(Color(0x99FFFFFF), Color(0xFF1A1A1A))

@Composable
internal fun OverlayTheme(
  root: OverlayRenderNode,
  explicit: OverlaySpecTheme? = null,
  content: @Composable () -> Unit,
) {
  val systemDark = isSystemInDarkTheme()
  val context = LocalContext.current
  val scheme =
    remember(root, explicit, systemDark) {
      val theme = overlayThemeSpec(root, systemDark, explicit)
      overlayColorScheme(theme, overlayDynamicScheme(context, theme))
    }
  MaterialTheme(colorScheme = scheme) {
    // Unstyled text and icons take this, so they follow the scheme instead of a fixed black.
    CompositionLocalProvider(LocalContentColor provides scheme.onSurface, content = content)
  }
}

/** Material You colours need API 31; older devices fall through to the seed or baseline. */
private fun overlayDynamicScheme(context: Context, theme: OverlayThemeSpec): ColorScheme? =
  if (theme.dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    if (theme.dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
  } else null

private const val DEVICE_COLOR_SOURCE = "device"
private const val DEGREES = 360f
private const val TERTIARY_HUE_ROTATION = 60f
private const val NEUTRAL_SATURATION = 0.06f
private const val SEED_MIN_SATURATION = 0.25f
private const val SEED_MAX_SATURATION = 0.85f
private const val OPAQUE_BACKGROUND_ALPHA = 0.99f
/** Below this, white content has more contrast than black, so the surface is a dark one. */
private const val DARK_LUMINANCE_CEILING = 0.179f
private const val MIN_ACCENT_CONTRAST = 3f
private const val ACCENT_STEP = 0.02f
private const val ACCENT_MIN_LIGHTNESS = 0.05f
private const val ACCENT_MAX_LIGHTNESS = 0.95f
