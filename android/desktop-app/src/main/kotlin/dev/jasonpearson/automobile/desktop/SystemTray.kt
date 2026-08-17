package dev.jasonpearson.automobile.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("SystemTray")

/**
 * System tray icon rendering the AutoMobile truck logo, with a context menu for window visibility
 * and quit actions.
 *
 * Menu bar guidance: the icon is a monochrome, template-style silhouette so it reads on both light
 * and dark menu bars. AWT tray icons are not auto-templated by the OS, so [detectDarkMenuBar]
 * probes the system appearance and the truck is drawn light (on dark bars) or dark (on light bars).
 * Connection status — which the colored status dot used to carry — is kept as a subtle cue: the
 * truck is drawn at full strength when connected and dimmed when disconnected, and the tooltip
 * still spells it out.
 */
@Composable
fun ApplicationScope.AutoMobileSystemTray(
  isConnected: Boolean,
  isWindowVisible: Boolean,
  onToggleWindow: () -> Unit,
  onQuit: () -> Unit,
) {
  // Start from the safe fallback and probe the real appearance off the UI thread, so a slow or
  // hung `defaults`/`reg` can never stall first composition (the tray/window still appear). The
  // effect probes immediately, then re-probes on a timer so the icon follows Light/Dark switches.
  var darkMenuBar by remember { mutableStateOf(DEFAULT_DARK_MENU_BAR) }
  LaunchedEffect(Unit) {
    while (true) {
      darkMenuBar = withContext(Dispatchers.IO) { detectDarkMenuBar() }
      delay(APPEARANCE_POLL_INTERVAL_MS)
    }
  }
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

/** How often the tray re-probes the system appearance so the icon follows Light/Dark switches. */
private const val APPEARANCE_POLL_INTERVAL_MS = 10_000L

/** Appearance assumed until the first probe returns, and whenever a probe can't be read. */
private const val DEFAULT_DARK_MENU_BAR = true

/** Upper bound on the appearance subprocess so a hung `defaults`/`reg` can't wedge the probe. */
private const val APPEARANCE_PROBE_TIMEOUT_MS = 2_000L

/** Result of an appearance-detection subprocess: its exit code and merged stdout/stderr. */
internal data class AppearanceProbeResult(val exitCode: Int, val output: String)

/**
 * Runs an appearance-detection command, or returns null if it can't be launched or times out. A
 * `fun interface` so tests can inject canned exit-code/output pairs without spawning a process.
 */
internal fun interface AppearanceProbe {
  fun run(command: List<String>): AppearanceProbeResult?
}

/**
 * Production probe: runs the command bounded by [APPEARANCE_PROBE_TIMEOUT_MS], killing it on
 * expiry.
 */
private val systemAppearanceProbe = AppearanceProbe { command ->
  try {
    val process = ProcessBuilder(command).redirectErrorStream(true).start()
    if (!process.waitFor(APPEARANCE_PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
      process.destroyForcibly()
      LOG.debug("menu bar appearance probe timed out; defaulting to dark")
      null
    } else {
      val output = process.inputStream.bufferedReader().use { it.readText() }
      AppearanceProbeResult(process.exitValue(), output)
    }
  } catch (e: IOException) {
    // Best-effort probe: if the command can't be run, fall back to the light-on-dark default.
    LOG.debug("Could not read menu bar appearance; defaulting to dark: ${e.message}")
    null
  } catch (e: InterruptedException) {
    // Restore the interrupt and fall back rather than failing icon rendering.
    Thread.currentThread().interrupt()
    LOG.debug("Interrupted reading menu bar appearance; defaulting to dark: ${e.message}")
    null
  }
}

/**
 * True when the tray truck should be drawn light. macOS reads `AppleInterfaceStyle`; Windows reads
 * the `SystemUsesLightTheme` registry value; other platforms (and any unreadable probe) fall back
 * to [DEFAULT_DARK_MENU_BAR]. [osName] and [probe] are injectable so the decision is testable
 * off-host.
 */
internal fun detectDarkMenuBar(
  osName: String = System.getProperty("os.name").orEmpty(),
  probe: AppearanceProbe = systemAppearanceProbe,
): Boolean {
  val os = osName.lowercase()
  return when {
    os.contains("mac") ->
      probe.run(listOf("defaults", "read", "-g", "AppleInterfaceStyle"))?.let {
        interpretMacAppearance(it.exitCode, it.output)
      } ?: DEFAULT_DARK_MENU_BAR
    os.contains("win") ->
      probe
        .run(
          listOf(
            "reg",
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
            "/v",
            "SystemUsesLightTheme",
          )
        )
        ?.let { interpretWindowsAppearance(it.exitCode, it.output) } ?: DEFAULT_DARK_MENU_BAR
    else -> DEFAULT_DARK_MENU_BAR
  }
}

/**
 * Interprets `defaults read -g AppleInterfaceStyle`. Dark mode exits 0 and prints "Dark"; light
 * mode leaves the key absent, so it exits non-zero with "... does not exist". Any *other* non-zero
 * result is an unexpected failure that falls back to [DEFAULT_DARK_MENU_BAR] rather than being read
 * as light (which would draw a dark icon on a dark menu bar).
 */
internal fun interpretMacAppearance(exitCode: Int, output: String): Boolean =
  when {
    exitCode == 0 -> output.trim().equals("Dark", ignoreCase = true)
    output.contains("does not exist", ignoreCase = true) -> false
    else -> DEFAULT_DARK_MENU_BAR
  }

/**
 * Interprets `reg query ... /v SystemUsesLightTheme`, which exits 0 and prints e.g.
 * "SystemUsesLightTheme REG_DWORD 0x1" (1 = light taskbar, wanting a dark icon). A non-zero exit
 * (missing value or other error) falls back to [DEFAULT_DARK_MENU_BAR].
 */
internal fun interpretWindowsAppearance(exitCode: Int, output: String): Boolean =
  if (exitCode != 0) {
    DEFAULT_DARK_MENU_BAR
  } else {
    !Regex("""SystemUsesLightTheme\s+REG_\w+\s+0x0*1\b""").containsMatchIn(output)
  }

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
