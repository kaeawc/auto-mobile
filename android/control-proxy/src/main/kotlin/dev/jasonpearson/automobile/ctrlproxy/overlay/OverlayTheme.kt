package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.content.Context
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import dev.jasonpearson.automobile.protocol.OverlaySpecThemeColors
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
  /** Explicit per-role hex overrides, painted over whichever scheme the rest selects. */
  val roles: OverlaySpecThemeColors? = null,
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
  val dark =
    overlayExplicitDark(explicit?.mode, systemDark)
      ?: overlayRoleSurfaceDark(explicit?.colors)
      ?: authored?.dark
      ?: systemDark
  val seed = explicit?.colors?.seed?.let(::overlayColor)
  val dynamic = explicit?.colors?.source == DEVICE_COLOR_SOURCE
  // Authored surfaces only match a scheme of the same polarity, and never override explicit
  // colours.
  val surface = authored?.surface?.takeIf { seed == null && !dynamic && authored.dark == dark }
  return OverlayThemeSpec(dark, surface, seed, dynamic, explicit?.colors)
}

/**
 * With no `mode`, an explicit `background` (else `surface`) role override is the screen colour the
 * author chose, so its luminance decides light or dark the way an authored background does.
 */
private fun overlayRoleSurfaceDark(colors: OverlaySpecThemeColors?): Boolean? =
  (colors?.background ?: colors?.surface)?.let {
    overlayColor(it).luminance() < DARK_LUMINANCE_CEILING
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
    else -> overlayRoleSurfaceDark(model.theme?.colors) ?: overlayAuthoredTheme(model.root)?.dark
  }

/**
 * [dynamicScheme] is the device's Material You scheme, supplied only on API 31+. It is used when
 * the spec asked for device colour; otherwise a seed generates the scheme, else the baseline
 * palette is used with the authored surface painted over it. Explicit role overrides are applied
 * last, over any of those.
 */
internal fun overlayColorScheme(
  theme: OverlayThemeSpec,
  dynamicScheme: ColorScheme? = null,
): ColorScheme = overlayBaseColorScheme(theme, dynamicScheme).withRoleOverrides(theme.roles)

private fun overlayBaseColorScheme(
  theme: OverlayThemeSpec,
  dynamicScheme: ColorScheme?,
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

/** This scheme with every role [roles] names replaced by that hex colour; null keeps it as is. */
internal fun ColorScheme.withRoleOverrides(roles: OverlaySpecThemeColors?): ColorScheme {
  // Seed and source alone name no role: keep this scheme instance.
  if (roles == null || roles == OverlaySpecThemeColors(roles.seed, roles.source)) return this
  fun String?.hex(): Color? = this?.let(::overlayColor)
  return copy(
    primary = roles.primary.hex() ?: primary,
    onPrimary = roles.onPrimary.hex() ?: onPrimary,
    primaryContainer = roles.primaryContainer.hex() ?: primaryContainer,
    onPrimaryContainer = roles.onPrimaryContainer.hex() ?: onPrimaryContainer,
    inversePrimary = roles.inversePrimary.hex() ?: inversePrimary,
    secondary = roles.secondary.hex() ?: secondary,
    onSecondary = roles.onSecondary.hex() ?: onSecondary,
    secondaryContainer = roles.secondaryContainer.hex() ?: secondaryContainer,
    onSecondaryContainer = roles.onSecondaryContainer.hex() ?: onSecondaryContainer,
    tertiary = roles.tertiary.hex() ?: tertiary,
    onTertiary = roles.onTertiary.hex() ?: onTertiary,
    tertiaryContainer = roles.tertiaryContainer.hex() ?: tertiaryContainer,
    onTertiaryContainer = roles.onTertiaryContainer.hex() ?: onTertiaryContainer,
    background = roles.background.hex() ?: background,
    onBackground = roles.onBackground.hex() ?: onBackground,
    surface = roles.surface.hex() ?: surface,
    onSurface = roles.onSurface.hex() ?: onSurface,
    surfaceVariant = roles.surfaceVariant.hex() ?: surfaceVariant,
    onSurfaceVariant = roles.onSurfaceVariant.hex() ?: onSurfaceVariant,
    surfaceTint = roles.surfaceTint.hex() ?: surfaceTint,
    inverseSurface = roles.inverseSurface.hex() ?: inverseSurface,
    inverseOnSurface = roles.inverseOnSurface.hex() ?: inverseOnSurface,
    error = roles.error.hex() ?: error,
    onError = roles.onError.hex() ?: onError,
    errorContainer = roles.errorContainer.hex() ?: errorContainer,
    onErrorContainer = roles.onErrorContainer.hex() ?: onErrorContainer,
    outline = roles.outline.hex() ?: outline,
    outlineVariant = roles.outlineVariant.hex() ?: outlineVariant,
    scrim = roles.scrim.hex() ?: scrim,
    surfaceBright = roles.surfaceBright.hex() ?: surfaceBright,
    surfaceDim = roles.surfaceDim.hex() ?: surfaceDim,
    surfaceContainer = roles.surfaceContainer.hex() ?: surfaceContainer,
    surfaceContainerHigh = roles.surfaceContainerHigh.hex() ?: surfaceContainerHigh,
    surfaceContainerHighest = roles.surfaceContainerHighest.hex() ?: surfaceContainerHighest,
    surfaceContainerLow = roles.surfaceContainerLow.hex() ?: surfaceContainerLow,
    surfaceContainerLowest = roles.surfaceContainerLowest.hex() ?: surfaceContainerLowest,
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

/** Host chrome colours: a background with the content (text, ripple) drawn over it. */
internal data class OverlayDismissColors(val background: Color, val content: Color)

/** The dismiss bar's translucency: quiet, but readable over any prototype. */
internal const val OVERLAY_DISMISS_BAR_ALPHA = 0.6f

/** Fallback scrim alphas, used when the spec authors no scrim colour. */
internal const val OVERLAY_SHEET_SCRIM_ALPHA = 0.4f
internal const val OVERLAY_DIALOG_SCRIM_ALPHA = 0.32f

/** The dismiss bar: `surfaceContainerHigh` at [OVERLAY_DISMISS_BAR_ALPHA] over `onSurface`. */
internal fun overlayDismissColors(scheme: ColorScheme): OverlayDismissColors =
  OverlayDismissColors(
    scheme.surfaceContainerHigh.copy(alpha = OVERLAY_DISMISS_BAR_ALPHA),
    scheme.onSurface,
  )

/** The persistent Close control: opaque, so authored content cannot show through it. */
internal fun overlayCloseColors(scheme: ColorScheme): OverlayDismissColors =
  OverlayDismissColors(scheme.surfaceContainerHigh, scheme.onSurface)

/** The sheet drag handle: the M3 default role. */
internal fun overlayHandleColor(scheme: ColorScheme): Color = scheme.onSurfaceVariant

internal fun overlaySheetScrimFallback(scheme: ColorScheme): Color =
  scheme.scrim.copy(alpha = OVERLAY_SHEET_SCRIM_ALPHA)

internal fun overlayDialogScrimFallback(scheme: ColorScheme): Color =
  scheme.scrim.copy(alpha = OVERLAY_DIALOG_SCRIM_ALPHA)

/** Placeholder box and its glyph, for an image, icon or nav item with nothing to draw. */
internal fun overlayPlaceholderColor(scheme: ColorScheme): Color = scheme.surfaceVariant

internal fun overlayPlaceholderContentColor(scheme: ColorScheme): Color = scheme.onSurfaceVariant

/**
 * Host chrome sits outside the spec content, so it needs the spec's theme itself: the resolved
 * [OverlayTheme] when the request carries the spec, else the baseline scheme for [dark].
 */
@Composable
internal fun OverlayHostTheme(
  root: OverlayRenderNode?,
  theme: OverlaySpecTheme?,
  dark: Boolean,
  content: @Composable () -> Unit,
) {
  if (root != null) OverlayTheme(root, theme, content)
  else
    MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
      CompositionLocalProvider(
        LocalContentColor provides MaterialTheme.colorScheme.onSurface,
        content = content,
      )
    }
}

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
  MaterialTheme(colorScheme = scheme, typography = typography, shapes = shapes) {
    // Unstyled text and icons take this, so they follow the scheme instead of a fixed black.
    CompositionLocalProvider(LocalContentColor provides scheme.onSurface, content = content)
  }
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

/**
 * A `cornerRadius` as a shape: dp as a rounded corner, a token as the theme's Shapes step, and
 * per-corner radii as a rounded shape with each omitted corner square.
 */
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
    is OverlayCornerRadius.Corners ->
      RoundedCornerShape(
        topStart = (radius.topStart ?: 0.0).toFloat().dp,
        topEnd = (radius.topEnd ?: 0.0).toFloat().dp,
        bottomEnd = (radius.bottomEnd ?: 0.0).toFloat().dp,
        bottomStart = (radius.bottomStart ?: 0.0).toFloat().dp,
      )
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
/** Below this, white content has more contrast than black, so the surface is a dark one. */
private const val DARK_LUMINANCE_CEILING = 0.179f
private const val MIN_ACCENT_CONTRAST = 3f
private const val ACCENT_STEP = 0.02f
private const val ACCENT_MIN_LIGHTNESS = 0.05f
private const val ACCENT_MAX_LIGHTNESS = 0.95f
