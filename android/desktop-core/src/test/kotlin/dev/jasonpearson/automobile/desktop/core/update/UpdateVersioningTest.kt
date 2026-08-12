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
  fun `prerelease numeric identifiers compare numerically, not lexically`() {
    // "rc.10" vs "rc.9": lexical compare would wrongly rank rc.10 below rc.9.
    assertTrue(isNewerVersion("1.0.0-rc.10", "1.0.0-rc.9"))
    assertFalse(isNewerVersion("1.0.0-rc.9", "1.0.0-rc.10"))
    // Alphanumeric identifiers still compare lexically; numeric ranks below alphanumeric.
    assertTrue(isNewerVersion("1.0.0-beta", "1.0.0-alpha"))
    assertTrue(isNewerVersion("1.0.0-rc", "1.0.0-1"))
  }

  @Test
  fun `a malformed candidate is never considered newer`() {
    assertFalse(isNewerVersion("v1.bad.0", "0.0.52"))
    assertFalse(isNewerVersion("nightly", "0.0.52"))
    assertFalse(isNewerVersion("", "0.0.52"))
  }

  @Test
  fun `a malformed prerelease suffix is rejected, not treated as newer`() {
    // Empty prerelease identifiers: "1.0.1-" and "1.0.1-alpha..1" are not valid SemVer.
    assertFalse(isNewerVersion("1.0.1-", "1.0.0"))
    assertFalse(isNewerVersion("1.0.1-alpha..1", "1.0.0"))
    // A well-formed prerelease on a higher core is still newer.
    assertTrue(isNewerVersion("0.0.53-rc.1", "0.0.52"))
  }

  @Test
  fun `build metadata is validated then ignored for precedence`() {
    // Malformed build metadata (empty identifier) rejects the whole version.
    assertFalse(isNewerVersion("0.0.54+bad..meta", "0.0.53"))
    // Well-formed build metadata is ignored: 0.0.54 is still newer than 0.0.53.
    assertTrue(isNewerVersion("0.0.54+build.1", "0.0.53"))
    // Build metadata does not affect precedence between two otherwise-equal versions.
    assertFalse(isNewerVersion("0.0.54+build.2", "0.0.54+build.1"))
  }

  @Test
  fun `versions with leading-zero segments are rejected`() {
    assertFalse(isNewerVersion("01.0.0", "0.0.52"))
  }

  @Test
  fun `numeric identifiers above Int MAX_VALUE compare numerically, not lexically`() {
    // Core segments beyond Int.MAX_VALUE (2147483647) must not overflow or reject.
    assertTrue(isNewerVersion("2147483648.0.0", "2147483647.0.0"))
    assertTrue(isNewerVersion("100000000000.0.0", "1.0.0"))
    // Oversized numeric prerelease identifiers: "10000000000" > "9999999999" numerically.
    assertTrue(isNewerVersion("1.0.0-10000000000", "1.0.0-9999999999"))
    assertFalse(isNewerVersion("1.0.0-9999999999", "1.0.0-10000000000"))
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
