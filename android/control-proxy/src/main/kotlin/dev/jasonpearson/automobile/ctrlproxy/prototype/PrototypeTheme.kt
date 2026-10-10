package dev.jasonpearson.automobile.ctrlproxy.prototype

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
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import dev.jasonpearson.automobile.protocol.PrototypeCornerRadius
import dev.jasonpearson.automobile.protocol.PrototypeModeValue
import dev.jasonpearson.automobile.protocol.PrototypeSpecTheme
import dev.jasonpearson.automobile.protocol.PrototypeSpecThemeColors
import dev.jasonpearson.automobile.protocol.PrototypeSpecThemeShapes
import dev.jasonpearson.automobile.protocol.PrototypeSpecThemeTypography

/**
 * The prototype's own Material scheme: the window has no app theme, so without one every Material
 * component falls back to the baseline light palette whatever the spec draws (#10434).
 */
internal data class PrototypeThemeSpec(
  val dark: Boolean,
  val surface: Color?,
  /** Seed colour a full scheme is generated from; null keeps the baseline palette. */
  val seed: Color? = null,
  /** The spec asked for device dynamic colour; honoured only when the OS supports it. */
  val dynamicColor: Boolean = false,
  /**
   * Explicit per-role hex overrides, painted over whichever scheme the rest selects: the flat roles
   * in both modes, then the `light` or `dark` map for the resolved mode.
   */
  val roles: PrototypeSpecThemeColors? = null,
)

/**
 * What a colour slot resolves against: the prototype's Material scheme and the resolved light or
 * dark appearance that picks a side of a `{light, dark}` pair.
 */
internal data class PrototypePalette(val scheme: ColorScheme, val dark: Boolean)

/** The prototype's resolved appearance, provided by [PrototypeTheme]; light outside one. */
internal val LocalPrototypeDark = staticCompositionLocalOf { false }

/**
 * The first opaque background on the tree's leading chain (root, then its first visible child, and
 * so on; hidden nodes paint nothing and are skipped) is what the author painted the screen with;
 * whichever of light or dark content reads better on it decides light or dark. A spec with no such
 * background follows the device setting. An explicit spec `theme` wins over this inference: its
 * `mode` decides light or dark, and its colours replace the background-derived surfaces (#10438).
 *
 * Only single hex values take part: a `{light, dark}` background pair and the `colors.light` /
 * `colors.dark` role maps depend on the mode, so neither can decide it (#11215 D2).
 */
internal fun prototypeThemeSpec(
  root: PrototypeRenderNode,
  systemDark: Boolean,
  explicit: PrototypeSpecTheme? = null,
): PrototypeThemeSpec {
  val authored = prototypeAuthoredTheme(root)
  val dark =
    prototypeExplicitDark(explicit?.mode, systemDark)
      ?: prototypeRoleSurfaceDark(explicit?.colors)
      ?: authored?.dark
      ?: systemDark
  val seed = explicit?.colors?.seed?.let(::prototypeColor)
  val dynamic = explicit?.colors?.source == DEVICE_COLOR_SOURCE
  // Authored surfaces only match a scheme of the same polarity, and never override explicit
  // colours.
  val surface = authored?.surface?.takeIf { seed == null && !dynamic && authored.dark == dark }
  return PrototypeThemeSpec(dark, surface, seed, dynamic, explicit?.colors)
}

/**
 * With no `mode`, an explicit `background` (else `surface`) role override is the screen colour the
 * author chose, so its luminance decides light or dark the way an authored background does.
 */
private fun prototypeRoleSurfaceDark(colors: PrototypeSpecThemeColors?): Boolean? =
  (colors?.background ?: colors?.surface)?.let {
    prototypeColor(it).luminance() < DARK_LUMINANCE_CEILING
  }

/** `light`/`dark` decide outright, `system` follows the device, and null means "not specified". */
private fun prototypeExplicitDark(mode: String?, systemDark: Boolean): Boolean? =
  when (mode) {
    "light" -> false
    "dark" -> true
    "system" -> systemDark
    else -> null
  }

/** The theme the author painted, or null when the spec paints no opaque background. */
internal fun prototypeAuthoredTheme(root: PrototypeRenderNode): PrototypeThemeSpec? {
  var node: PrototypeRenderNode? = root
  while (node != null) {
    val background = node.style.background
    if (node.visible && background != null && background.alpha >= OPAQUE_BACKGROUND_ALPHA)
      return PrototypeThemeSpec(background.luminance() < DARK_LUMINANCE_CEILING, background)
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
internal fun prototypeHostDark(model: PrototypeRenderModel): Boolean? =
  when (model.theme?.mode) {
    "light" -> false
    "dark" -> true
    "system" -> null
    else ->
      prototypeRoleSurfaceDark(model.theme?.colors) ?: prototypeAuthoredTheme(model.root)?.dark
  }

/**
 * [dynamicScheme] is the device's Material You scheme, supplied only on API 31+. It is used when
 * the spec asked for device colour; otherwise a seed generates the scheme, else the baseline
 * palette is used with the authored surface painted over it. Explicit role overrides are applied
 * last, over any of those: the flat `colors.<role>` values, then the `colors.light` or
 * `colors.dark` map for the resolved mode, which therefore wins for a role both name (#11215 D2).
 */
internal fun prototypeColorScheme(
  theme: PrototypeThemeSpec,
  dynamicScheme: ColorScheme? = null,
): ColorScheme =
  prototypeBaseColorScheme(theme, dynamicScheme)
    .withRoleOverrides(theme.roles)
    .withRoleMap(if (theme.dark) theme.roles?.dark else theme.roles?.light)

private fun prototypeBaseColorScheme(
  theme: PrototypeThemeSpec,
  dynamicScheme: ColorScheme?,
): ColorScheme {
  if (theme.dynamicColor && dynamicScheme != null) return dynamicScheme
  theme.seed?.let {
    return prototypeSeedColorScheme(it, theme.dark)
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
internal fun ColorScheme.withRoleOverrides(roles: PrototypeSpecThemeColors?): ColorScheme {
  // Seed and source alone name no role: keep this scheme instance.
  val named = roles?.copy(seed = null, source = null, light = null, dark = null)
  if (named == null || named == PrototypeSpecThemeColors()) return this
  fun String?.hex(): Color? = this?.let(::prototypeColor)
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
 * This scheme with every role [roles] names (role name to hex) replaced; null or empty keeps it.
 */
internal fun ColorScheme.withRoleMap(roles: Map<String, String>?): ColorScheme {
  if (roles.isNullOrEmpty()) return this
  fun hex(role: String): Color? = roles[role]?.let(::prototypeColor)
  return copy(
    primary = hex("primary") ?: primary,
    onPrimary = hex("onPrimary") ?: onPrimary,
    primaryContainer = hex("primaryContainer") ?: primaryContainer,
    onPrimaryContainer = hex("onPrimaryContainer") ?: onPrimaryContainer,
    inversePrimary = hex("inversePrimary") ?: inversePrimary,
    secondary = hex("secondary") ?: secondary,
    onSecondary = hex("onSecondary") ?: onSecondary,
    secondaryContainer = hex("secondaryContainer") ?: secondaryContainer,
    onSecondaryContainer = hex("onSecondaryContainer") ?: onSecondaryContainer,
    tertiary = hex("tertiary") ?: tertiary,
    onTertiary = hex("onTertiary") ?: onTertiary,
    tertiaryContainer = hex("tertiaryContainer") ?: tertiaryContainer,
    onTertiaryContainer = hex("onTertiaryContainer") ?: onTertiaryContainer,
    background = hex("background") ?: background,
    onBackground = hex("onBackground") ?: onBackground,
    surface = hex("surface") ?: surface,
    onSurface = hex("onSurface") ?: onSurface,
    surfaceVariant = hex("surfaceVariant") ?: surfaceVariant,
    onSurfaceVariant = hex("onSurfaceVariant") ?: onSurfaceVariant,
    surfaceTint = hex("surfaceTint") ?: surfaceTint,
    inverseSurface = hex("inverseSurface") ?: inverseSurface,
    inverseOnSurface = hex("inverseOnSurface") ?: inverseOnSurface,
    error = hex("error") ?: error,
    onError = hex("onError") ?: onError,
    errorContainer = hex("errorContainer") ?: errorContainer,
    onErrorContainer = hex("onErrorContainer") ?: onErrorContainer,
    outline = hex("outline") ?: outline,
    outlineVariant = hex("outlineVariant") ?: outlineVariant,
    scrim = hex("scrim") ?: scrim,
    surfaceBright = hex("surfaceBright") ?: surfaceBright,
    surfaceDim = hex("surfaceDim") ?: surfaceDim,
    surfaceContainer = hex("surfaceContainer") ?: surfaceContainer,
    surfaceContainerHigh = hex("surfaceContainerHigh") ?: surfaceContainerHigh,
    surfaceContainerHighest = hex("surfaceContainerHighest") ?: surfaceContainerHighest,
    surfaceContainerLow = hex("surfaceContainerLow") ?: surfaceContainerLow,
    surfaceContainerLowest = hex("surfaceContainerLowest") ?: surfaceContainerLowest,
  )
}

/**
 * A Material 3 style scheme from one colour. This is an HSL approximation of tonal palettes (no HCT
 * dependency): primary keeps the seed's hue and saturation, secondary is a muted version of it,
 * tertiary is rotated 60 degrees, and neutrals carry a trace of the hue. Tones follow the Material
 * light (primary 40, containers 90) and dark (primary 80, containers 30) assignments.
 */
internal fun prototypeSeedColorScheme(seed: Color, dark: Boolean): ColorScheme {
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
internal data class PrototypeDismissColors(val background: Color, val content: Color)

/** The dismiss bar's translucency: quiet, but readable over any prototype. */
internal const val PROTOTYPE_DISMISS_BAR_ALPHA = 0.6f

/** Fallback scrim alphas, used when the spec authors no scrim colour. */
internal const val PROTOTYPE_SHEET_SCRIM_ALPHA = 0.4f
internal const val PROTOTYPE_DIALOG_SCRIM_ALPHA = 0.32f

/** The dismiss bar: `surfaceContainerHigh` at [PROTOTYPE_DISMISS_BAR_ALPHA] over `onSurface`. */
internal fun prototypeDismissColors(scheme: ColorScheme): PrototypeDismissColors =
  PrototypeDismissColors(
    scheme.surfaceContainerHigh.copy(alpha = PROTOTYPE_DISMISS_BAR_ALPHA),
    scheme.onSurface,
  )

/** The persistent Close control: opaque, so authored content cannot show through it. */
internal fun prototypeCloseColors(scheme: ColorScheme): PrototypeDismissColors =
  PrototypeDismissColors(scheme.surfaceContainerHigh, scheme.onSurface)

/** The sheet drag handle: the M3 default role. */
internal fun prototypeHandleColor(scheme: ColorScheme): Color = scheme.onSurfaceVariant

internal fun prototypeSheetScrimFallback(scheme: ColorScheme): Color =
  scheme.scrim.copy(alpha = PROTOTYPE_SHEET_SCRIM_ALPHA)

internal fun prototypeDialogScrimFallback(scheme: ColorScheme): Color =
  scheme.scrim.copy(alpha = PROTOTYPE_DIALOG_SCRIM_ALPHA)

/** Placeholder box and its glyph, for an image, icon or nav item with nothing to draw. */
internal fun prototypePlaceholderColor(scheme: ColorScheme): Color = scheme.surfaceVariant

internal fun prototypePlaceholderContentColor(scheme: ColorScheme): Color = scheme.onSurfaceVariant

/**
 * Host chrome sits outside the spec content, so it needs the spec's theme itself: the resolved
 * [PrototypeTheme] when the request carries the spec, else the baseline scheme for [dark].
 */
@Composable
internal fun PrototypeHostTheme(
  root: PrototypeRenderNode?,
  theme: PrototypeSpecTheme?,
  dark: Boolean,
  content: @Composable () -> Unit,
) {
  if (root != null) PrototypeTheme(root, theme, content)
  else
    MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
      CompositionLocalProvider(
        LocalContentColor provides MaterialTheme.colorScheme.onSurface,
        LocalPrototypeDark provides dark,
        content = content,
      )
    }
}

@Composable
internal fun PrototypeTheme(
  root: PrototypeRenderNode,
  explicit: PrototypeSpecTheme? = null,
  content: @Composable () -> Unit,
) {
  val systemDark = isSystemInDarkTheme()
  val context = LocalContext.current
  val palette =
    remember(root, explicit, systemDark) {
      val theme = prototypeThemeSpec(root, systemDark, explicit)
      PrototypePalette(
        prototypeColorScheme(theme, prototypeDynamicScheme(context, theme)),
        theme.dark,
      )
    }
  val typography = remember(explicit) { prototypeTypography(explicit?.typography) }
  val shapes = remember(explicit) { prototypeShapes(explicit?.shapes) }
  MaterialTheme(colorScheme = palette.scheme, typography = typography, shapes = shapes) {
    CompositionLocalProvider(
      // Unstyled text and icons take this, so they follow the scheme instead of a fixed black.
      LocalContentColor provides palette.scheme.onSurface,
      // The same resolved mode picks the side of every {light, dark} colour and image pair.
      LocalPrototypeDark provides palette.dark,
      content = content,
    )
  }
}

/**
 * The Material 3 type scale with every role's size and line height multiplied by `scale`, and the
 * family replaced when the spec names one. No typography keeps the stock scale.
 */
internal fun prototypeTypography(spec: PrototypeSpecThemeTypography?): Typography {
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
internal fun prototypeTextRole(typography: Typography, token: String?): TextStyle? =
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
internal fun prototypeShapes(spec: PrototypeSpecThemeShapes?): Shapes {
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
internal fun prototypeColorRole(scheme: ColorScheme, role: String): Color? =
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

/**
 * The colour of a spec colour slot. A `{light, dark}` pair first gives the side for the palette's
 * mode; that value (or the single one) is then a hex colour or a role name looked up in the
 * palette's scheme, which already carries the theme's flat and per-mode role overrides. [literal]
 * is the colour the render model parsed for a single hex value, reused instead of parsing again; it
 * is also the result when [spec] is absent.
 */
internal fun prototypeResolveColor(
  palette: PrototypePalette,
  literal: Color?,
  spec: PrototypeModeValue?,
): Color? {
  val value = spec?.let { prototypeModeValue(it, palette.dark) } ?: return literal
  if (!value.startsWith("#")) return prototypeColorRole(palette.scheme, value) ?: literal
  val parsed = literal?.takeIf { spec is PrototypeModeValue.Single && it.isSpecified }
  return parsed ?: prototypeColor(value)
}

/** The scheme and resolved mode of the enclosing [PrototypeTheme]. */
@Composable
internal fun prototypePalette(): PrototypePalette =
  PrototypePalette(MaterialTheme.colorScheme, LocalPrototypeDark.current)

/** [prototypeResolveColor] against the active prototype theme. */
@Composable
internal fun prototypeThemedColor(literal: Color?, spec: PrototypeModeValue?): Color? =
  prototypeResolveColor(prototypePalette(), literal, spec)

/**
 * A `cornerRadius` as a shape: dp as a rounded corner, a token as the theme's Shapes step, and
 * per-corner radii as a rounded shape with each omitted corner square.
 */
internal fun prototypeCornerShape(shapes: Shapes, radius: PrototypeCornerRadius): Shape =
  when (radius) {
    is PrototypeCornerRadius.Dp -> RoundedCornerShape(radius.dp.toFloat().dp)
    is PrototypeCornerRadius.Token ->
      when (radius.name) {
        "extraSmall" -> shapes.extraSmall
        "small" -> shapes.small
        "medium" -> shapes.medium
        "large" -> shapes.large
        "extraLarge" -> shapes.extraLarge
        "full" -> RoundedCornerShape(percent = FULL_CORNER_PERCENT)
        else -> RoundedCornerShape(0.dp)
      }
    is PrototypeCornerRadius.Corners ->
      RoundedCornerShape(
        topStart = (radius.topStart ?: 0.0).toFloat().dp,
        topEnd = (radius.topEnd ?: 0.0).toFloat().dp,
        bottomEnd = (radius.bottomEnd ?: 0.0).toFloat().dp,
        bottomStart = (radius.bottomStart ?: 0.0).toFloat().dp,
      )
  }

/** Material You colours need API 31; older devices fall through to the seed or baseline. */
private fun prototypeDynamicScheme(context: Context, theme: PrototypeThemeSpec): ColorScheme? =
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
