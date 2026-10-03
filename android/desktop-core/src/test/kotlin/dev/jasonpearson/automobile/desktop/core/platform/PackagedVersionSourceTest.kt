package dev.jasonpearson.automobile.desktop.core.platform

import java.net.URL
import java.net.URLConnection
import java.net.URLStreamHandler
import java.util.Collections
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
  fun `provider prefers the resource version over a different manifest version`() {
    val loader = FakeVersionClassLoader("version=1.2.3\n")
    val provider = RuntimeAppVersionProvider(PackagedVersionSource(classLoader = loader))
    assertEquals(AppVersion.of("1.2.3"), provider.current())
    assertEquals(0, loader.manifestScans, "a valid resource avoids the manifest fallback")
  }

  @Test
  fun `provider uses the manifest version when the resource is absent`() {
    val loader = FakeVersionClassLoader(null)
    val provider = RuntimeAppVersionProvider(PackagedVersionSource(classLoader = loader))
    assertEquals(AppVersion.of("4.5.6"), provider.current())
    assertEquals(1, loader.manifestScans)
  }

  @Test
  fun `provider uses the manifest version when the resource version is blank`() {
    val loader = FakeVersionClassLoader("version=   \n")
    val provider = RuntimeAppVersionProvider(PackagedVersionSource(classLoader = loader))
    assertEquals(AppVersion.of("4.5.6"), provider.current())
  }

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

  private class FakeVersionClassLoader(private val resource: String?) : ClassLoader(null) {
    var manifestScans = 0
      private set

    override fun getResourceAsStream(name: String) =
      if (name == "automobile-version.properties") resource?.byteInputStream() else null

    override fun getResources(name: String): java.util.Enumeration<URL> {
      if (name != "META-INF/MANIFEST.MF") return Collections.emptyEnumeration()
      manifestScans++
      val manifest =
        "Manifest-Version: 1.0\nImplementation-Title: AutoMobile\nImplementation-Version: 4.5.6\n\n"
      val url =
        URL(
          null,
          "memory:manifest",
          object : URLStreamHandler() {
            override fun openConnection(url: URL) =
              object : URLConnection(url) {
                override fun connect() = Unit

                override fun getInputStream() = manifest.byteInputStream()
              }
          },
        )
      return Collections.enumeration(listOf(url))
    }
  }
}
