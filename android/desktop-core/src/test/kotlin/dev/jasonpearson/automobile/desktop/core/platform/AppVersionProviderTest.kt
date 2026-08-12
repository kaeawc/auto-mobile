package dev.jasonpearson.automobile.desktop.core.platform

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Acceptance criteria for #5223: the app exposes its own version at runtime, and cleanly degrades
 * to a development sentinel when no packaged version is present. The manifest/resource lookup is
 * behind the [VersionSource] seam, faked here so the mapping is verified without a packaged jar.
 */
class AppVersionProviderTest {

  private fun provider(raw: String?) = RuntimeAppVersionProvider(VersionSource { raw })

  @Test
  fun `packaged version is preserved verbatim and marked non-development`() {
    val version = provider("0.0.52-SNAPSHOT").current()
    assertEquals("0.0.52-SNAPSHOT", version.raw)
    assertFalse(version.isDevelopment, "a resolved packaged version is not a development run")
  }

  @Test
  fun `release version without a suffix is preserved`() {
    assertEquals("0.0.52", provider("0.0.52").current().raw)
  }

  @Test
  fun `absent version resolves to the development sentinel`() {
    val version = provider(null).current()
    assertEquals(AppVersion.Dev, version)
    assertTrue(version.isDevelopment)
  }

  @Test
  fun `blank version resolves to the development sentinel`() {
    assertEquals(AppVersion.Dev, provider("   ").current())
  }

  @Test
  fun `surrounding whitespace is trimmed from a packaged version`() {
    val version = provider("  1.2.3  ").current()
    assertEquals("1.2.3", version.raw)
    assertFalse(version.isDevelopment)
  }
}
