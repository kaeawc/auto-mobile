package dev.jasonpearson.automobile.desktop.core.theme

import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PlatformIconsTest {

  @Test
  fun `logo maps iOS to Apple and Android to the robot`() {
    assertSame(PlatformIcons.Apple, PlatformIcons.logo(isIos = true))
    assertSame(PlatformIcons.Android, PlatformIcons.logo(isIos = false))
  }

  @Test
  fun `the two logos are distinct, named 24dp vectors`() {
    assertNotSame(PlatformIcons.Android, PlatformIcons.Apple)
    assertTrue(PlatformIcons.Android.name.isNotBlank())
    assertTrue(PlatformIcons.Apple.name.isNotBlank())
    assertEquals24(PlatformIcons.Android.defaultWidth.value)
    assertEquals24(PlatformIcons.Apple.defaultWidth.value)
  }

  private fun assertEquals24(value: Float) =
    assertTrue("expected a 24dp default width but was $value", value == 24f)
}
