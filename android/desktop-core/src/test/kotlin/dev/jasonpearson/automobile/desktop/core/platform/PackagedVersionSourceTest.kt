package dev.jasonpearson.automobile.desktop.core.platform

import java.util.jar.Attributes
import java.util.jar.Manifest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Verifies the real [PackagedVersionSource] lookup path chosen for #5223: read the build-generated
 * classpath resource first, fall back to the app jar manifest, and yield null (→ [AppVersion.Dev])
 * when neither is present. The resource read is exercised against a committed test resource so the
 * chosen primary mechanism is actually covered, not just the fake seam.
 */
class PackagedVersionSourceTest {

  @Test
  fun `reads the version from the generated classpath resource`() {
    val source = PackagedVersionSource(resourceName = "test-automobile-version.properties")
    assertEquals("9.9.9-test", source.resolve())
  }

  @Test
  fun `returns null when neither resource nor an AutoMobile manifest is present`() {
    // A resource name that does not exist forces the manifest fallback; the test classpath has no
    // jar stamped Implementation-Title: AutoMobile, so the whole chain yields null.
    val source = PackagedVersionSource(resourceName = "no-such-version-resource.properties")
    assertNull(source.resolve())
  }

  @Test
  fun `versionFromProperties reads a non-blank version and rejects blank or missing`() {
    assertEquals("1.2.3", versionFromProperties("version=1.2.3\ntitle=AutoMobile\n"))
    assertNull(versionFromProperties("version=\n"))
    assertNull(versionFromProperties("title=AutoMobile\n"))
  }

  @Test
  fun `versionFromManifest reads Implementation-Version only for the AutoMobile title`() {
    val autoMobile =
      Manifest().apply {
        mainAttributes.putValue("Manifest-Version", "1.0")
        mainAttributes[Attributes.Name.IMPLEMENTATION_TITLE] = "AutoMobile"
        mainAttributes[Attributes.Name.IMPLEMENTATION_VERSION] = "0.0.52"
      }
    assertEquals("0.0.52", versionFromManifest(autoMobile))

    val otherJar =
      Manifest().apply {
        mainAttributes.putValue("Manifest-Version", "1.0")
        mainAttributes[Attributes.Name.IMPLEMENTATION_TITLE] = "kotlinx-coroutines-core"
        mainAttributes[Attributes.Name.IMPLEMENTATION_VERSION] = "1.9.0"
      }
    assertNull(
      versionFromManifest(otherJar),
      "a third-party jar's version must not be mistaken for ours",
    )
  }
}
