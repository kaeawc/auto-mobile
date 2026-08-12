package dev.jasonpearson.automobile.desktop.core.update

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Semver comparison (AC3) and OS asset resolution (AC4) for #5224, as pure functions. */
class UpdateVersioningTest {

  @Test
  fun `newer numeric versions are detected, including multi-digit segments`() {
    assertTrue(isNewerVersion("0.0.53", "0.0.52"))
    assertTrue(isNewerVersion("0.1.0", "0.0.52"))
    assertTrue(isNewerVersion("1.0.0", "0.9.9"))
    // 10 > 9 numerically, not lexically — the string compare "1.2.10" < "1.2.9" would be wrong.
    assertTrue(isNewerVersion("1.2.10", "1.2.9"))
  }

  @Test
  fun `equal or older versions are not newer`() {
    assertFalse(isNewerVersion("0.0.52", "0.0.52"))
    assertFalse(isNewerVersion("0.0.51", "0.0.52"))
    assertFalse(isNewerVersion("1.2.9", "1.2.10"))
  }

  @Test
  fun `a leading v is ignored on either side`() {
    assertTrue(isNewerVersion("v0.0.53", "0.0.52"))
    assertFalse(isNewerVersion("v0.0.52", "0.0.52"))
  }

  @Test
  fun `a release outranks its own prerelease and snapshot`() {
    assertTrue(isNewerVersion("0.0.52", "0.0.52-SNAPSHOT"))
    assertFalse(isNewerVersion("0.0.52-SNAPSHOT", "0.0.52"))
  }

  @Test
  fun `resolveAsset matches the platform suffix and returns null when absent`() {
    val assets =
      listOf(
        ReleaseAsset("AutoMobile-0.0.53-macos.dmg", "https://x/dmg", 10),
        ReleaseAsset("AutoMobile-0.0.53-windows.msi", "https://x/msi", 20),
        ReleaseAsset("AutoMobile-0.0.53-linux.deb", "https://x/deb", 30),
      )
    assertEquals("AutoMobile-0.0.53-macos.dmg", resolveAsset(assets, HostPlatform.MAC)?.name)
    assertEquals("AutoMobile-0.0.53-windows.msi", resolveAsset(assets, HostPlatform.WINDOWS)?.name)
    assertEquals("AutoMobile-0.0.53-linux.deb", resolveAsset(assets, HostPlatform.LINUX)?.name)
    assertNull(resolveAsset(assets.take(1), HostPlatform.WINDOWS))
  }

  @Test
  fun `host platform detection maps os_name strings`() {
    assertEquals(HostPlatform.MAC, HostPlatform.current("Mac OS X"))
    assertEquals(HostPlatform.WINDOWS, HostPlatform.current("Windows 11"))
    assertEquals(HostPlatform.LINUX, HostPlatform.current("Linux"))
    assertNull(HostPlatform.current("SunOS"))
  }
}
