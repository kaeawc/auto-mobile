package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.window.ApplicationScope
import androidx.compose.ui.window.Tray
import java.awt.Color
import java.awt.RenderingHints
import java.awt.image.BufferedImage

/**
 * System tray icon showing daemon connection status with a colored dot (green = connected, red =
 * disconnected) and a context menu for window visibility and quit actions.
 */
@Composable
fun ApplicationScope.AutoMobileSystemTray(
  isConnected: Boolean,
  isWindowVisible: Boolean,
  onToggleWindow: () -> Unit,
  onQuit: () -> Unit,
) {
  val icon = if (isConnected) connectedIcon else disconnectedIcon
  val tooltip = if (isConnected) "AutoMobile \u2014 Connected" else "AutoMobile \u2014 Disconnected"

  Tray(
    icon = icon,
    tooltip = tooltip,
    menu = {
      Item(
        text = if (isWindowVisible) "Hide Window" else "Show Window",
        onClick = onToggleWindow,
      )
      Separator()
      Item("Quit AutoMobile", onClick = onQuit)
    },
  )
}

private val connectedIcon: Painter by lazy { createStatusIcon(Color(0x4C, 0xAF, 0x50)) }
private val disconnectedIcon: Painter by lazy { createStatusIcon(Color(0xF4, 0x43, 0x36)) }

private fun createStatusIcon(color: Color): Painter {
  val size = 16
  val image = BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB)
  val g = image.createGraphics()
  g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
  g.color = color
  g.fillOval(2, 2, size - 4, size - 4)
  g.dispose()
  return BitmapPainter(image.toComposeImageBitmap())
}
