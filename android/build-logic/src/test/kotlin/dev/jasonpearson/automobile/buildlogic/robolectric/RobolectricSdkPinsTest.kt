package dev.jasonpearson.automobile.buildlogic.robolectric

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RobolectricSdkPinsTest {
  @Test
  fun acceptsSupportedPin() {
    assertTrue(violations("# comment\nsdk=30\n", targetSdk = 36).isEmpty())
  }

  @Test
  fun requiresPinWhenAndroidResourcesAreIncluded() {
    assertTrue(violations(null, includeAndroidResources = true).isNotEmpty())
  }

  @Test
  fun rejectsPinAboveMaximum() {
    assertTrue(violations("sdk=38").any { it.contains("exceeds") })
  }

  @Test
  fun rejectsPinBelowMinimum() {
    assertTrue(violations("sdk=23", minSdk = 24).any { it.contains("below minSdk") })
  }

  @Test
  fun reportsUnsupportedTargetWithoutPin() {
    val result = violations(null, targetSdk = 38)
    assertTrue(result.any { it.contains("targetSdk 38") && it.contains("supports (37)") })
  }

  @Test
  fun acceptsTargetAboveMaximumWithSupportedPin() {
    assertTrue(violations("sdk=30", targetSdk = 38).isEmpty())
  }

  @Test
  fun allowsUnconfiguredLibraryWithoutProperties() {
    assertTrue(violations(null, targetSdk = null, minSdk = 24).isEmpty())
  }

  @Test
  fun rejectsNonNumericPin() {
    assertEquals(1, violations("sdk=latest").size)
  }

  @Test
  fun acceptsNumericAndKnownVersionCodeValues() {
    val source =
      """@Config(sdk = [24, 25, 28, 29, 30, 33, 34, Build.VERSION_CODES.Q, Build.VERSION_CODES.R, Build.VERSION_CODES.TIRAMISU])"""
    assertTrue(RobolectricSdkPins.sourceViolations(source, "src/test/Example.kt", 35).isEmpty())
  }

  @Test
  fun rejectsTooNewAndUnknownVersionCodesWithFilePath() {
    val result =
      RobolectricSdkPins.sourceViolations(
        "@Config(sdk = [Build.VERSION_CODES.BAKLAVA, Build.VERSION_CODES.FUTURE])",
        "src/test/Foo.java",
        35,
      )
    assertTrue(result.any { it.contains("src/test/Foo.java") && it.contains("36") })
    assertTrue(result.any { it.contains("src/test/Foo.java") && it.contains("numeric literal") })
  }

  @Test
  fun rejectsFloatingConstantsAndAllowsOldestSdk() {
    for (constant in listOf("NEWEST_SDK", "ALL_SDKS", "TARGET_SDK")) {
      assertTrue(
        RobolectricSdkPins.sourceViolations("@Config(sdk = Config.$constant)", "Test.kt", 35)
          .isNotEmpty(),
      )
    }
    assertTrue(
      RobolectricSdkPins.sourceViolations("@Config(sdk = Config.OLDEST_SDK)", "Test.kt", 35)
        .isEmpty(),
    )
  }

  @Test
  fun readsMultilineConfigAndScalarSdk() {
    val source =
      """@Config(
      qualifiers = "land",
      sdk = 36
    )"""
    assertTrue(
      RobolectricSdkPins.sourceViolations(source, "Test.kt", 35).single().contains("Test.kt"),
    )
  }

  @Test
  fun primaryPropertiesEnforceMinimumButNestedPropertiesDoNot() {
    assertTrue(
      RobolectricSdkPins.propertiesViolations(
          "sdk=23",
          "src/test/resources/robolectric.properties",
          24,
          35,
          true,
        )
        .isNotEmpty(),
    )
    assertTrue(
      RobolectricSdkPins.propertiesViolations(
          "sdk=23",
          "src/test/resources/pkg/robolectric.properties",
          24,
          35,
          false,
        )
        .isEmpty(),
    )
  }

  private fun violations(
    properties: String?,
    targetSdk: Int? = 36,
    minSdk: Int = 24,
    includeAndroidResources: Boolean = false,
  ): List<String> =
    RobolectricSdkPins.violations(
      properties,
      targetSdk,
      minSdk,
      includeAndroidResources,
      maxSupportedSdk = 37,
    )
}
