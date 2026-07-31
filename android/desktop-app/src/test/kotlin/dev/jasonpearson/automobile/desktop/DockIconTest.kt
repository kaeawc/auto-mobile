package dev.jasonpearson.automobile.desktop

import java.awt.image.BufferedImage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.fail

/**
 * Covers [setDockIcon] and [loadBundledImage] off-Mac by injecting a fake for the unfakeable
 * [java.awt.Taskbar] platform boundary. All cases are headless-safe and finish well under 100ms.
 */
class DockIconTest {

  /**
   * Records what [setDockIcon] installs; [throwOnInstall] simulates a platform that lies about
   * support.
   */
  private class FakeDockIconInstaller(
    override val isSupported: Boolean,
    private val throwOnInstall: Boolean = false,
  ) : DockIconInstaller {
    var installedImage: BufferedImage? = null
      private set

    var installCount = 0
      private set

    override fun install(image: BufferedImage) {
      installCount++
      if (throwOnInstall) throw UnsupportedOperationException("simulated unsupported platform")
      installedImage = image
    }
  }

  private fun oneByOneImage() = BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB)

  @Test
  fun `unsupported installer never consults the loader and installs nothing`() {
    val installer = FakeDockIconInstaller(isSupported = false)

    setDockIcon(installer) { fail("image loader must not be consulted when unsupported") }

    assertEquals(0, installer.installCount)
    assertNull(installer.installedImage)
  }

  @Test
  fun `supported installer receives the exact loaded image`() {
    val installer = FakeDockIconInstaller(isSupported = true)
    val expected = oneByOneImage()

    setDockIcon(installer) { expected }

    assertEquals(1, installer.installCount)
    assertSame(expected, installer.installedImage)
  }

  @Test
  fun `missing resource installs nothing and does not throw`() {
    val installer = FakeDockIconInstaller(isSupported = true)

    setDockIcon(installer) { null }

    assertEquals(0, installer.installCount)
    assertNull(installer.installedImage)
  }

  @Test
  fun `install throwing UnsupportedOperationException is caught, not propagated`() {
    val installer = FakeDockIconInstaller(isSupported = true, throwOnInstall = true)

    // Must return normally despite install() throwing.
    setDockIcon(installer) { oneByOneImage() }

    assertEquals(1, installer.installCount)
    assertNull(installer.installedImage)
  }

  @Test
  fun `bundled dock icon resource is present and decodable on the classpath`() {
    assertNotNull(
      loadBundledImage("/icons/app-icon.png"),
      "the branded dock icon must be bundled on the runtime classpath",
    )
  }

  @Test
  fun `absent resource loads as null`() {
    assertNull(loadBundledImage("/icons/does-not-exist.png"))
  }
}
