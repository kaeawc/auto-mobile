package dev.jasonpearson.automobile.buildlogic.sdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidCompileSdkTest {
  @Test
  fun parsesMajorOnlyAsMinorZero() {
    assertEquals(AndroidCompileSdk(major = 37, minor = 0), AndroidCompileSdk.parse("37"))
  }

  @Test
  fun parsesMajorAndMinor() {
    assertEquals(AndroidCompileSdk(major = 37, minor = 1), AndroidCompileSdk.parse("37.1"))
  }

  @Test
  fun rejectsMalformedValues() {
    listOf("", "37.", "android-37", "37.1.0", "37-ext19").forEach { value ->
      assertThrows(IllegalArgumentException::class.java) { AndroidCompileSdk.parse(value) }
    }
  }
}
