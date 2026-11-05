package dev.jasonpearson.automobile.buildlogic.robolectric

import java.io.File
import java.io.StringReader
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class RobolectricAndroidAllTest {
  @Test
  fun coordinateMatchesRobolectricPreinstrumentedJarNames() {
    assertEquals(
      "org.robolectric:android-all-instrumented:15-robolectric-13954326-i7",
      RobolectricAndroidAll.coordinate(35),
    )
    assertEquals(
      "org.robolectric:android-all-instrumented:7.0.0_r1-robolectric-r1-i7",
      RobolectricAndroidAll.coordinate(24),
    )
  }

  @Test
  fun coordinateIsNullForAnSdkRobolectricDoesNotShip() {
    assertNull(RobolectricAndroidAll.coordinate(22))
    assertNull(RobolectricAndroidAll.coordinate(38))
  }

  @Test
  fun oldestSdkIsRobolectricsOldest() {
    assertEquals(23, RobolectricAndroidAll.OLDEST_SDK)
  }

  @Test
  fun rejectsACatalogRobolectricVersionTheTableWasNotReadFrom() {
    RobolectricAndroidAll.requireCatalogVersion(RobolectricAndroidAll.ROBOLECTRIC_VERSION)
    val error =
      assertThrows(IllegalStateException::class.java) {
        RobolectricAndroidAll.requireCatalogVersion("4.18")
      }
    assertEquals(true, error.message!!.contains("DefaultSdkProvider"))
  }

  @Test
  fun moduleSdksUnionsConfigLevelsAndPins() {
    val sdks =
      RobolectricAndroidAll.moduleSdks(
        sources =
          listOf(
            "@Config(sdk = [Build.VERSION_CODES.R, 34])\nclass A",
            "@Config(sdk = [Config.OLDEST_SDK])\nclass B",
          ),
        propertiesFiles = listOf("# default\nsdk=24\n"),
        hasPrimaryPin = true,
      )
    assertEquals(setOf(23, 24, 30, 34), sdks)
  }

  @Test
  fun moduleWithoutPrimaryPinAlsoNeedsTheOldestSdk() {
    assertEquals(
      setOf(23, 29),
      RobolectricAndroidAll.moduleSdks(listOf("@Config(sdk = [29])"), emptyList(), false),
    )
  }

  @Test
  fun depsPropertiesLoadBackToTheJarPaths() {
    val jar = File("/cache/a b=c:d\ne\rf/android-all-instrumented-15-robolectric-13954326-i7.jar")
    val text = RobolectricAndroidAll.depsProperties(mapOf("15-robolectric-13954326-i7" to jar))
    val loaded = Properties().apply { load(StringReader(text)) }
    assertEquals(
      jar.absolutePath,
      loaded.getProperty("org.robolectric:android-all-instrumented:15-robolectric-13954326-i7"),
    )
  }
}
