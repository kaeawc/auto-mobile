package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.window.ApplicationScope
import androidx.compose.ui.window.Tray
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.awt.AlphaComposite
import java.awt.Color
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.IOException

private val LOG = LoggerFactory.getLogger("SystemTray")

/**
 * System tray icon rendering the AutoMobile truck logo, with a context menu for window visibility
 * and quit actions.
 *
 * macOS menu bar guidance: the icon is a monochrome, template-style silhouette so it reads on both
 * light and dark menu bars. AWT tray icons are not auto-templated by macOS, so [detectDarkMenuBar]
 * probes the menu bar's appearance and the truck is drawn light (on dark bars) or dark (on light
 * bars). Connection status — which the colored status dot used to carry — is kept as a subtle cue:
 * the truck is drawn at full strength when connected and dimmed when disconnected, and the tooltip
 * still spells it out.
 */
@Composable
fun ApplicationScope.AutoMobileSystemTray(
  isConnected: Boolean,
  isWindowVisible: Boolean,
  onToggleWindow: () -> Unit,
  onQuit: () -> Unit,
) {
  // Probed once: menu bar appearance rarely changes mid-session, and re-shelling out to `defaults`
  // on every recomposition (the daemon poll toggles connection state on a timer) would be wasteful.
  val darkMenuBar = remember { detectDarkMenuBar() }
  val icon = remember(isConnected, darkMenuBar) { truckTrayIcon(isConnected, darkMenuBar) }
  val tooltip = if (isConnected) "AutoMobile — Connected" else "AutoMobile — Disconnected"

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

/**
 * True when the tray truck should be drawn light. On macOS this reads the system-wide
 * `AppleInterfaceStyle`; on other platforms it assumes a dark tray background (the common case for
 * Windows/Linux system trays).
 */
internal fun detectDarkMenuBar(): Boolean {
  val os = System.getProperty("os.name")?.lowercase().orEmpty()
  if (!os.contains("mac")) return true
  return try {
    val process =
      ProcessBuilder("defaults", "read", "-g", "AppleInterfaceStyle")
        .redirectErrorStream(true)
        .start()
    val output = process.inputStream.bufferedReader().use { it.readText() }
    process.waitFor()
    interpretAppleInterfaceStyle(output)
  } catch (e: IOException) {
    // Best-effort probe: if `defaults` can't be run, fall back to the light-on-dark default.
    LOG.debug("Could not read menu bar appearance; defaulting to dark: ${e.message}")
    true
  } catch (e: InterruptedException) {
    // Restore the interrupt and fall back rather than failing icon rendering.
    Thread.currentThread().interrupt()
    LOG.debug("Interrupted reading menu bar appearance; defaulting to dark: ${e.message}")
    true
  }
}

/**
 * Interprets the stdout of `defaults read -g AppleInterfaceStyle`. macOS prints `Dark` in dark mode
 * and errors ("... does not exist") in light mode, so anything that is not exactly `Dark` is light.
 */
internal fun interpretAppleInterfaceStyle(output: String): Boolean =
  output.trim().equals("Dark", ignoreCase = true)

/** Foreground color for the tray truck given the menu bar appearance and connection state. */
internal fun trayForegroundColor(darkMenuBar: Boolean, connected: Boolean): Color {
  val base = if (darkMenuBar) Color(0xEC, 0xEC, 0xEC) else Color(0x24, 0x24, 0x24)
  val alpha = if (connected) 255 else 120
  return Color(base.red, base.green, base.blue, alpha)
}

/** The AutoMobile truck silhouette (from docs/img/logo.svg), bundled as a tintable alpha mask. */
private val trayTruckMask: BufferedImage? by lazy { loadBundledImage(TRAY_TRUCK_RESOURCE) }

internal const val TRAY_TRUCK_RESOURCE = "/icons/tray-truck.png"

/** Supersampled canvas edge; the OS scales this down to the menu bar's status-item size. */
internal const val TRAY_ICON_SIZE = 64

private fun truckTrayIcon(connected: Boolean, darkMenuBar: Boolean): Painter {
  val fg = trayForegroundColor(darkMenuBar, connected)
  val mask = trayTruckMask
  val image =
    if (mask != null) tintTrayTruck(mask, TRAY_ICON_SIZE, fg)
    else fallbackTrayIcon(TRAY_ICON_SIZE, fg)
  return BitmapPainter(image.toComposeImageBitmap())
}

/**
 * Renders the AutoMobile truck [mask] (a monochrome alpha stencil of the logo) tinted with [fg] and
 * fitted into a square [canvas] with a small margin, preserving the truck's aspect ratio. [fg]'s
 * alpha carries through, so a dimmed [fg] yields a dimmed truck.
 */
internal fun tintTrayTruck(mask: BufferedImage, canvas: Int, fg: Color): BufferedImage {
  val image = BufferedImage(canvas, canvas, BufferedImage.TYPE_INT_ARGB)
  val g = image.createGraphics()
  g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
  g.setRenderingHint(
    RenderingHints.KEY_INTERPOLATION,
    RenderingHints.VALUE_INTERPOLATION_BILINEAR,
  )

  // Fit the mask into the padded canvas, preserving aspect (the truck is wider than it is tall).
  val available = canvas * (1.0 - 2 * TRAY_MARGIN_FRACTION)
  val scale = minOf(available / mask.width, available / mask.height)
  val w = (mask.width * scale).toInt()
  val h = (mask.height * scale).toInt()
  val x = (canvas - w) / 2
  val y = (canvas - h) / 2
  g.drawImage(mask, x, y, w, h, null)

  // Recolor to fg while keeping the mask's alpha; SrcIn multiplies fg's alpha in, so a dimmed fg
  // dims the whole truck.
  g.composite = AlphaComposite.SrcIn
  g.color = fg
  g.fillRect(0, 0, canvas, canvas)

  g.dispose()
  return image
}

private const val TRAY_MARGIN_FRACTION = 0.08

/** Last-resort tray icon if the bundled truck mask is missing: a simple filled dot in [fg]. */
private fun fallbackTrayIcon(canvas: Int, fg: Color): BufferedImage {
  val image = BufferedImage(canvas, canvas, BufferedImage.TYPE_INT_ARGB)
  val g = image.createGraphics()
  g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
  g.color = fg
  val inset = (canvas * 0.2).toInt()
  g.fillOval(inset, inset, canvas - 2 * inset, canvas - 2 * inset)
  g.dispose()
  return image
}
