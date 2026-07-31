package dev.jasonpearson.automobile.desktop

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.awt.Taskbar
import java.awt.image.BufferedImage
import javax.imageio.ImageIO

private val LOG = LoggerFactory.getLogger("DockIcon")

/**
 * Narrow seam over the macOS Dock-icon platform API so the startup icon logic is testable off-Mac.
 *
 * [java.awt.Taskbar] is a `final` JDK class with a private constructor, so it cannot be faked
 * directly — this thin interface is the fake-able boundary.
 */
internal interface DockIconInstaller {
  val isSupported: Boolean

  fun install(image: BufferedImage)
}

/** Production installer backed by [java.awt.Taskbar]. */
internal class TaskbarDockIconInstaller : DockIconInstaller {
  // Short-circuit: getTaskbar() may only be called once isTaskbarSupported() is true.
  override val isSupported: Boolean
    get() =
      Taskbar.isTaskbarSupported() && Taskbar.getTaskbar().isSupported(Taskbar.Feature.ICON_IMAGE)

  override fun install(image: BufferedImage) {
    Taskbar.getTaskbar().iconImage = image
  }
}

/**
 * Loads a classpath resource as an image; `null` if the resource is absent or undecodable. Pure and
 * headless-safe, so it can be exercised in unit tests off-Mac.
 */
internal fun loadBundledImage(resourcePath: String): BufferedImage? =
  TaskbarDockIconInstaller::class.java.getResourceAsStream(resourcePath)?.use { ImageIO.read(it) }

/**
 * Sets the macOS Dock icon from the bundled PNG. Guarded so non-macOS / unsupported platforms are a
 * no-op and never throw.
 *
 * Ordering constraint: [DockIconInstaller.isSupported] / [DockIconInstaller.install] touch
 * [java.awt.Taskbar.getTaskbar], which initializes the AWT toolkit, so this must run only after
 * `apple.awt.application.name` has been set.
 *
 * The [installer] and [imageLoader] parameters default to the production platform implementations;
 * tests inject fakes to exercise the supported / missing-resource / throwing paths
 * deterministically.
 */
internal fun setDockIcon(
  installer: DockIconInstaller = TaskbarDockIconInstaller(),
  imageLoader: (String) -> BufferedImage? = ::loadBundledImage,
) {
  if (!installer.isSupported) return
  val image = imageLoader("/icons/app-icon.png") ?: return
  try {
    installer.install(image)
  } catch (e: UnsupportedOperationException) {
    // Some platforms report ICON_IMAGE support but still throw here; ignore but leave a trace.
    LOG.warn("Setting the Dock icon is unsupported on this platform", e)
  }
}
