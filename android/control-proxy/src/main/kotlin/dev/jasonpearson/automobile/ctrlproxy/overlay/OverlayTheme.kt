package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance

/**
 * The overlay's own Material scheme: the window has no app theme, so without one every Material
 * component falls back to the baseline light palette whatever the spec draws (#10434).
 */
internal data class OverlayThemeSpec(val dark: Boolean, val surface: Color?)

/**
 * The first opaque background on the tree's leading chain (root, then its first visible child, and
 * so on) is what the author painted the screen with; its luminance decides light or dark. A spec
 * with no such background follows the device setting.
 */
internal fun overlayThemeSpec(root: OverlayRenderNode, systemDark: Boolean): OverlayThemeSpec =
  overlayAuthoredTheme(root) ?: OverlayThemeSpec(systemDark, null)

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

internal fun overlayColorScheme(theme: OverlayThemeSpec): ColorScheme {
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

/** Translucent host dismiss colours for a scheme: quiet, but readable over any prototype. */
internal data class OverlayDismissColors(val background: Color, val content: Color)

internal fun overlayDismissColors(dark: Boolean): OverlayDismissColors =
  if (dark) OverlayDismissColors(Color(0x99000000), Color(0xFFE6E6E6))
  else OverlayDismissColors(Color(0x99FFFFFF), Color(0xFF1A1A1A))

@Composable
internal fun OverlayTheme(root: OverlayRenderNode, content: @Composable () -> Unit) {
  val systemDark = isSystemInDarkTheme()
  val scheme = remember(root, systemDark) { overlayColorScheme(overlayThemeSpec(root, systemDark)) }
  MaterialTheme(colorScheme = scheme, content = content)
}

private const val OPAQUE_BACKGROUND_ALPHA = 0.99f
private const val DARK_LUMINANCE_CEILING = 0.5f
