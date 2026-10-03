package dev.jasonpearson.automobile.desktop.core.shell

import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import kotlin.test.assertEquals
import org.junit.Test

class AboutDialogTest {
  @Test
  fun `packaged version shows raw version`() {
    assertEquals("Version 1.2.3", aboutVersionText(AppVersion.of("1.2.3")))
  }

  @Test
  fun `snapshot development build preserves raw version`() {
    assertEquals(
      "Development build (0.0.67-SNAPSHOT)",
      aboutVersionText(AppVersion.of("0.0.67-SNAPSHOT")),
    )
  }

  @Test
  fun `bare development sentinel omits raw version`() {
    assertEquals("Development build", aboutVersionText(AppVersion.Dev))
  }
}
