package dev.jasonpearson.automobile.playground

import org.junit.Assert.assertEquals
import org.junit.Test

class TrimMemoryLoggerTest {
  @Test
  fun `names running moderate level`() {
    assertEquals("RUNNING_MODERATE", trimMemoryLevelName(5))
  }

  @Test
  fun `names running low level`() {
    assertEquals("RUNNING_LOW", trimMemoryLevelName(10))
  }

  @Test
  fun `names running critical level`() {
    assertEquals("RUNNING_CRITICAL", trimMemoryLevelName(15))
  }

  @Test
  fun `names hidden level`() {
    assertEquals("HIDDEN", trimMemoryLevelName(20))
  }

  @Test
  fun `names background level`() {
    assertEquals("BACKGROUND", trimMemoryLevelName(40))
  }

  @Test
  fun `names moderate level`() {
    assertEquals("MODERATE", trimMemoryLevelName(60))
  }

  @Test
  fun `names complete level`() {
    assertEquals("COMPLETE", trimMemoryLevelName(80))
  }

  @Test
  fun `includes unknown level value`() {
    assertEquals("UNKNOWN(99)", trimMemoryLevelName(99))
  }
}
