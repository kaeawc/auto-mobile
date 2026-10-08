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
      KeyboardProfiles.GBOARD.style.accentArgb != KeyboardProfiles.SAMSUNG.style.accentArgb,
    )
  }

  @Test
  fun `profile lookup remains case insensitive and rejects unknown ids`() {
    KeyboardProfiles.all.forEach { profile ->
      assertEquals(profile, KeyboardProfiles.byId(profile.id.uppercase()))
    }
    assertNull(KeyboardProfiles.byId("unknown"))
  }

  @Test
  fun `catalog and profile versions preserve legacy ids`() {
    assertEquals(1, KeyboardProfiles.CATALOG_VERSION)
    assertEquals(listOf("direct", "gboard", "samsung"), KeyboardProfiles.all.map { it.id })
    assertTrue(KeyboardProfiles.all.all { it.version == 1 })
    assertEquals(listOf(1), KeyboardProfiles.SUPPORTED_CATALOG_VERSIONS)
    assertEquals("experimental", KeyboardProfiles.SAMSUNG.evidenceStatus)
    assertTrue(KeyboardProfiles.SAMSUNG.evidenceNote.contains("comparison remains pending"))
    assertEquals(1, KeyboardProfiles.negotiateCatalogVersion(listOf(2, 1)))
    assertNull(KeyboardProfiles.negotiateCatalogVersion(listOf(2)))
  }
}
