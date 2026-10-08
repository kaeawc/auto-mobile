package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.content.Context
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import dev.jasonpearson.automobile.protocol.OverlayCornerRadius
import dev.jasonpearson.automobile.protocol.OverlaySpecTheme
import dev.jasonpearson.automobile.protocol.OverlaySpecThemeShapes
import dev.jasonpearson.automobile.protocol.OverlaySpecThemeTypography

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
 * so on) is what the author painted the screen with; its luminance decides light or dark. A spec
 * with no such background follows the device setting. An explicit spec `theme` wins over this
 * inference: its `mode` decides light or dark, and its colours replace the background-derived
 * surfaces (#10438).
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
    if (background != null && background.alpha >= OPAQUE_BACKGROUND_ALPHA)
      return OverlayThemeSpec(background.luminance() < DARK_LUMINANCE_CEILING, background)
    node = node.children.getOrNull(if (node.role == "pager") node.page else 0)
  }
  return null
}

/**
 * Whether the host chrome (the dismiss control) should draw dark, or null to follow the device. An
 * explicit `light`/`dark` mode wins over the authored background.
 */
internal fun overlayHostDark(model: OverlayRenderModel): Boolean? =
  when (model.theme?.mode) {
    "light" -> false
    "dark" -> true
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
  val (hue, saturation) = seed.hueAndSaturation()
  val chroma = saturation.coerceIn(SEED_MIN_SATURATION, SEED_MAX_SATURATION)

  fun tone(h: Float, s: Float, light: Float, darkTone: Float) =
    Color.hsl(h.mod(DEGREES), s.coerceIn(0f, 1f), if (dark) darkTone else light)

  val tertiaryHue = hue + TERTIARY_HUE_ROTATION
  val neutral = NEUTRAL_SATURATION
  return (if (dark) darkColorScheme() else lightColorScheme()).copy(
    primary = tone(hue, chroma, 0.40f, 0.80f),
    onPrimary = tone(hue, chroma, 1.00f, 0.20f),
    primaryContainer = tone(hue, chroma, 0.90f, 0.30f),
    onPrimaryContainer = tone(hue, chroma, 0.10f, 0.90f),
    secondary = tone(hue, chroma * 0.35f, 0.40f, 0.80f),
    onSecondary = tone(hue, chroma * 0.35f, 1.00f, 0.20f),
    secondaryContainer = tone(hue, chroma * 0.35f, 0.90f, 0.30f),
    onSecondaryContainer = tone(hue, chroma * 0.35f, 0.10f, 0.90f),
    tertiary = tone(tertiaryHue, chroma * 0.6f, 0.40f, 0.80f),
    onTertiary = tone(tertiaryHue, chroma * 0.6f, 1.00f, 0.20f),
    tertiaryContainer = tone(tertiaryHue, chroma * 0.6f, 0.90f, 0.30f),
    onTertiaryContainer = tone(tertiaryHue, chroma * 0.6f, 0.10f, 0.90f),
    background = tone(hue, neutral, 0.98f, 0.07f),
    onBackground = tone(hue, neutral, 0.10f, 0.90f),
    surface = tone(hue, neutral, 0.98f, 0.07f),
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
  val typography = remember(explicit) { overlayTypography(explicit?.typography) }
  val shapes = remember(explicit) { overlayShapes(explicit?.shapes) }
  MaterialTheme(colorScheme = scheme, typography = typography, shapes = shapes, content = content)
}

/**
 * The Material 3 type scale with every role's size and line height multiplied by `scale`, and the
 * family replaced when the spec names one. No typography keeps the stock scale.
 */
internal fun overlayTypography(spec: OverlaySpecThemeTypography?): Typography {
  val base = Typography()
  if (spec == null) return base
  val scale = (spec.scale ?: 1.0).toFloat()
  val family =
    when (spec.fontFamily) {
      "sans" -> FontFamily.SansSerif
      "serif" -> FontFamily.Serif
      "mono" -> FontFamily.Monospace
      else -> null
    }

  fun TextStyle.themed() =
    copy(
      fontSize = if (fontSize.isSpecified) fontSize * scale else fontSize,
      lineHeight = if (lineHeight.isSpecified) lineHeight * scale else lineHeight,
      fontFamily = family ?: fontFamily,
    )
  return Typography(
    displayLarge = base.displayLarge.themed(),
    displayMedium = base.displayMedium.themed(),
    displaySmall = base.displaySmall.themed(),
    headlineLarge = base.headlineLarge.themed(),
    headlineMedium = base.headlineMedium.themed(),
    headlineSmall = base.headlineSmall.themed(),
    titleLarge = base.titleLarge.themed(),
    titleMedium = base.titleMedium.themed(),
    titleSmall = base.titleSmall.themed(),
    bodyLarge = base.bodyLarge.themed(),
    bodyMedium = base.bodyMedium.themed(),
    bodySmall = base.bodySmall.themed(),
    labelLarge = base.labelLarge.themed(),
    labelMedium = base.labelMedium.themed(),
    labelSmall = base.labelSmall.themed(),
  )
}

/** The Material type role a `textStyle` token names, or null for no (or an unknown) token. */
internal fun overlayTextRole(typography: Typography, token: String?): TextStyle? =
  when (token) {
    "displayLarge" -> typography.displayLarge
    "displayMedium" -> typography.displayMedium
    "displaySmall" -> typography.displaySmall
    "headlineLarge" -> typography.headlineLarge
    "headlineMedium" -> typography.headlineMedium
    "headlineSmall" -> typography.headlineSmall
    "titleLarge" -> typography.titleLarge
    "titleMedium" -> typography.titleMedium
    "titleSmall" -> typography.titleSmall
    "bodyLarge" -> typography.bodyLarge
    "bodyMedium" -> typography.bodyMedium
    "bodySmall" -> typography.bodySmall
    "labelLarge" -> typography.labelLarge
    "labelMedium" -> typography.labelMedium
    "labelSmall" -> typography.labelSmall
    else -> null
  }

/**
 * The Material corner families for a `corner` choice. `medium` is the stock Material 3 scale; the
 * others shift every step of it, `full` making every family a pill.
 */
internal fun overlayShapes(spec: OverlaySpecThemeShapes?): Shapes {
  val steps =
    when (spec?.corner) {
      "none" -> listOf(0, 0, 0, 0, 0)
      "small" -> listOf(2, 4, 6, 8, 12)
      "large" -> listOf(8, 12, 20, 28, 40)
      "full" -> null
      else -> return Shapes()
    }
  if (steps == null) {
    val pill = RoundedCornerShape(percent = FULL_CORNER_PERCENT)
    return Shapes(pill, pill, pill, pill, pill)
  }
  val (xs, s, m, l, xl) = steps.map { RoundedCornerShape(it.dp) }
  return Shapes(extraSmall = xs, small = s, medium = m, large = l, extraLarge = xl)
}

/**
 * The Material 3 [ColorScheme] colour a spec role name (`primary`, `surfaceContainer`...) names.
 */
internal fun overlayColorRole(scheme: ColorScheme, role: String): Color? =
  when (role) {
    "primary" -> scheme.primary
    "onPrimary" -> scheme.onPrimary
    "primaryContainer" -> scheme.primaryContainer
    "onPrimaryContainer" -> scheme.onPrimaryContainer
    "inversePrimary" -> scheme.inversePrimary
    "secondary" -> scheme.secondary
    "onSecondary" -> scheme.onSecondary
    "secondaryContainer" -> scheme.secondaryContainer
    "onSecondaryContainer" -> scheme.onSecondaryContainer
    "tertiary" -> scheme.tertiary
    "onTertiary" -> scheme.onTertiary
    "tertiaryContainer" -> scheme.tertiaryContainer
    "onTertiaryContainer" -> scheme.onTertiaryContainer
    "background" -> scheme.background
    "onBackground" -> scheme.onBackground
    "surface" -> scheme.surface
    "onSurface" -> scheme.onSurface
    "surfaceVariant" -> scheme.surfaceVariant
    "onSurfaceVariant" -> scheme.onSurfaceVariant
    "surfaceTint" -> scheme.surfaceTint
    "inverseSurface" -> scheme.inverseSurface
    "inverseOnSurface" -> scheme.inverseOnSurface
    "error" -> scheme.error
    "onError" -> scheme.onError
    "errorContainer" -> scheme.errorContainer
    "onErrorContainer" -> scheme.onErrorContainer
    "outline" -> scheme.outline
    "outlineVariant" -> scheme.outlineVariant
    "scrim" -> scheme.scrim
    "surfaceBright" -> scheme.surfaceBright
    "surfaceDim" -> scheme.surfaceDim
    "surfaceContainer" -> scheme.surfaceContainer
    "surfaceContainerHigh" -> scheme.surfaceContainerHigh
    "surfaceContainerHighest" -> scheme.surfaceContainerHighest
    "surfaceContainerLow" -> scheme.surfaceContainerLow
    "surfaceContainerLowest" -> scheme.surfaceContainerLowest
    else -> null
  }

/** [literal] is the parsed hex colour; a role name in [spec] takes the active scheme's colour. */
internal fun overlayResolveColor(scheme: ColorScheme, literal: Color?, spec: String?): Color? =
  spec?.takeIf { !it.startsWith("#") }?.let { overlayColorRole(scheme, it) } ?: literal

/** [overlayResolveColor] against the active overlay MaterialTheme. */
@Composable
internal fun overlayThemedColor(literal: Color?, spec: String?): Color? =
  overlayResolveColor(MaterialTheme.colorScheme, literal, spec)

/** A `cornerRadius` as a shape: dp as a rounded corner, a token as the theme's Shapes step. */
internal fun overlayCornerShape(shapes: Shapes, radius: OverlayCornerRadius): Shape =
  when (radius) {
    is OverlayCornerRadius.Dp -> RoundedCornerShape(radius.dp.toFloat().dp)
    is OverlayCornerRadius.Token ->
      when (radius.name) {
        "extraSmall" -> shapes.extraSmall
        "small" -> shapes.small
        "medium" -> shapes.medium
        "large" -> shapes.large
        "extraLarge" -> shapes.extraLarge
        "full" -> RoundedCornerShape(percent = FULL_CORNER_PERCENT)
        else -> RoundedCornerShape(0.dp)
      }
  }

/** Material You colours need API 31; older devices fall through to the seed or baseline. */
private fun overlayDynamicScheme(context: Context, theme: OverlayThemeSpec): ColorScheme? =
  if (theme.dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    if (theme.dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
  } else null

private const val FULL_CORNER_PERCENT = 50
private const val DEVICE_COLOR_SOURCE = "device"
private const val DEGREES = 360f
private const val TERTIARY_HUE_ROTATION = 60f
private const val NEUTRAL_SATURATION = 0.06f
private const val SEED_MIN_SATURATION = 0.25f
private const val SEED_MAX_SATURATION = 0.85f
private const val OPAQUE_BACKGROUND_ALPHA = 0.99f
private const val DARK_LUMINANCE_CEILING = 0.5f
