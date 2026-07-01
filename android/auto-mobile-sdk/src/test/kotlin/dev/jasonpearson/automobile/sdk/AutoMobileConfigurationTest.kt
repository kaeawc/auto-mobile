package dev.jasonpearson.automobile.sdk

import org.junit.Assert.*
import org.junit.Test

class AutoMobileConfigurationTest {

  @Test
  fun `default values match expected constants`() {
    val config = AutoMobileConfiguration.Builder().build()

    assertEquals(50, config.bufferSize)
    assertEquals(500L, config.flushIntervalMs)
    assertEquals(100, config.maxBreadcrumbs)
    assertEquals(30_000L, config.sessionTimeoutMs)
  }

  @Test
  fun `builder fluent chaining works`() {
    val config =
        AutoMobileConfiguration.Builder()
            .bufferSize(200)
            .flushIntervalMs(1000)
            .maxBreadcrumbs(50)
            .sessionTimeoutMs(60_000)
            .build()

    assertEquals(200, config.bufferSize)
    assertEquals(1000L, config.flushIntervalMs)
    assertEquals(50, config.maxBreadcrumbs)
    assertEquals(60_000L, config.sessionTimeoutMs)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `bufferSize zero throws`() {
    AutoMobileConfiguration.Builder().bufferSize(0).build()
  }

  @Test(expected = IllegalArgumentException::class)
  fun `bufferSize negative throws`() {
    AutoMobileConfiguration.Builder().bufferSize(-1).build()
  }

  @Test(expected = IllegalArgumentException::class)
  fun `flushIntervalMs zero throws`() {
    AutoMobileConfiguration.Builder().flushIntervalMs(0).build()
  }

  @Test(expected = IllegalArgumentException::class)
  fun `flushIntervalMs negative throws`() {
    AutoMobileConfiguration.Builder().flushIntervalMs(-100).build()
  }

  @Test(expected = IllegalArgumentException::class)
  fun `maxBreadcrumbs zero throws`() {
    AutoMobileConfiguration.Builder().maxBreadcrumbs(0).build()
  }

  @Test(expected = IllegalArgumentException::class)
  fun `maxBreadcrumbs negative throws`() {
    AutoMobileConfiguration.Builder().maxBreadcrumbs(-5).build()
  }

  @Test(expected = IllegalArgumentException::class)
  fun `sessionTimeoutMs zero throws`() {
    AutoMobileConfiguration.Builder().sessionTimeoutMs(0).build()
  }

  @Test(expected = IllegalArgumentException::class)
  fun `sessionTimeoutMs negative throws`() {
    AutoMobileConfiguration.Builder().sessionTimeoutMs(-1000).build()
  }

  @Test
  fun `configuration is a data class with correct equals and copy`() {
    val config =
        AutoMobileConfiguration.Builder()
            .bufferSize(100)
            .flushIntervalMs(200)
            .maxBreadcrumbs(300)
            .sessionTimeoutMs(400)
            .build()

    val copy = config.copy(bufferSize = 999)

    assertEquals(100, config.bufferSize)
    assertEquals(999, copy.bufferSize)
    assertEquals(config.flushIntervalMs, copy.flushIntervalMs)
  }
}
