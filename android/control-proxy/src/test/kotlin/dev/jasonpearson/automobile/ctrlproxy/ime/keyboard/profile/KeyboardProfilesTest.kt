package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyboardProfilesTest {
  @Test
  fun `profiles have distinct usable styles`() {
    val styles = KeyboardProfiles.all.map { it.style }
    assertEquals(3, styles.toSet().size)
    styles.forEach { style ->
      assertTrue(style.keyHeightPortraitDp > style.keyHeightLandscapeDp)
      assertTrue(style.keyGapDp > 0f)
      assertTrue(style.keyCornerRadiusDp > 0f)
    }
    assertTrue(
      KeyboardProfiles.GBOARD.style.accentArgb != KeyboardProfiles.SAMSUNG.style.accentArgb
    )
  }

  @Test
  fun `profile lookup remains case insensitive and rejects unknown ids`() {
    KeyboardProfiles.all.forEach { profile ->
      assertEquals(profile, KeyboardProfiles.byId(profile.id.uppercase()))
    }
    assertNull(KeyboardProfiles.byId("unknown"))
  }
}
