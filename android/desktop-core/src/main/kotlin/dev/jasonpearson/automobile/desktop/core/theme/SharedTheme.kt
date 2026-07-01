package dev.jasonpearson.automobile.desktop.core.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp

/**
 * Compatibility layer that maps MaterialTheme colors to a structure matching the Jewel globalColors
 * API surface used throughout the shared dashboards.
 *
 * This lets both the IDE plugin (via Jewel theme) and the desktop app (via Material3 theme) provide
 * colors through a single abstraction.
 */
data class SharedTextColors(
    val normal: Color,
    val info: Color,
    val error: Color,
    val warning: Color,
    val success: Color,
)

data class SharedOutlineColors(
    val focused: Color,
)

data class SharedGlobalColors(
    val text: SharedTextColors,
    val outlines: SharedOutlineColors,
    val panelBackground: Color,
)

/** Named text styles for consistent typography across the desktop app. */
object DesktopTypography {
  val caption = TextStyle(fontSize = 9.sp)
  val label = TextStyle(fontSize = 10.sp)
  val body = TextStyle(fontSize = 11.sp)
  val bodyLarge = TextStyle(fontSize = 12.sp)
  val title = TextStyle(fontSize = 14.sp)
  val heading = TextStyle(fontSize = 16.sp)
}

object SharedTheme {
  val globalColors: SharedGlobalColors
    @Composable
    @ReadOnlyComposable
    get() =
        SharedGlobalColors(
            text =
                SharedTextColors(
                    normal = MaterialTheme.colorScheme.onSurface,
                    info = MaterialTheme.colorScheme.primary,
                    error = MaterialTheme.colorScheme.error,
                    warning = MaterialTheme.colorScheme.tertiary,
                    success = Color(0xFF4CAF50),
                ),
            outlines =
                SharedOutlineColors(
                    focused = MaterialTheme.colorScheme.primary,
                ),
            panelBackground = MaterialTheme.colorScheme.surface,
        )
}
