package dev.jasonpearson.automobile.desktop.core.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/**
 * Custom platform glyphs (Android robot, Apple mark) used everywhere the desktop app used to print
 * the 🤖 / 🍎 emoji. Self-contained [ImageVector]s built from SVG path data — no image assets, so
 * they are safe in the jj/worktree checkout (nothing routes through LFS) and tint cleanly to the
 * surrounding text color. Draw via `Icon(PlatformIcons.logo(isIos), tint =
 * PlatformIcons.tint(...))`.
 */
object PlatformIcons {

  /**
   * Android brand green; legible on both light and dark surfaces, so it needs no theme override.
   */
  val AndroidGreen: Color = Color(0xFF3DDC84)

  /** The Android robot mark (24dp viewport). */
  val Android: ImageVector by lazy { vector("AndroidLogo", ANDROID_PATH) }

  /** The Apple mark (24dp viewport). */
  val Apple: ImageVector by lazy { vector("AppleLogo", APPLE_PATH) }

  /** The logo for a platform, keyed on whether it is iOS (Apple) or Android. */
  fun logo(isIos: Boolean): ImageVector = if (isIos) Apple else Android

  /**
   * Tint for a platform logo: Android keeps its brand green; Apple takes the theme's on-surface
   * color so the mark stays legible in both light and dark.
   */
  @Composable
  @ReadOnlyComposable
  fun tint(isIos: Boolean): Color = if (isIos) MaterialTheme.colorScheme.onSurface else AndroidGreen

  private fun vector(name: String, pathData: String): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
      )
      .apply {
        // Fill is overridden by Icon's tint at draw time; a solid fill keeps the vector valid when
        // it is ever drawn without a tint.
        addPath(
          pathData = PathParser().parsePathString(pathData).toNodes(),
          fill = SolidColor(Color.Black),
        )
      }
      .build()

  // The classic Android robot ("bugdroid") — body, legs, arms, antennae, eyes (Material geometry).
  private const val ANDROID_PATH =
    "M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 " +
      "1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8C2.67 8 2 8.67 2 9.5v7c0 .83.67 1.5 " +
      "1.5 1.5S5 17.33 5 16.5v-7C5 8.67 4.33 8 3.5 8zm17 0c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 " +
      "1.5 1.5s1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zm-4.97-5.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-" +
      ".2-.51-.2-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.96 0-1.86.23-2.66.63L7.85.15c-.2-.2-." +
      "51-.2-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.97 3.26 6 5.01 6 7h12c0-1.99-.97-3.75-2.47-4.84zM" +
      "10 5H9V4h1v1zm5 0h-1V4h1v1z"

  // The Apple mark — bitten body plus the leaf.
  private const val APPLE_PATH =
    "M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1." +
      "31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02" +
      " 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81" +
      ".03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.82M13 3.5c.73-.83 1.94-1.46 2.94-1.5.1" +
      "3 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"
}
