package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals

class ResourceUriBuilderTest {

  @Test
  fun `omits absent parameters`() {
    assertEquals("automobile:test-runs", TestRunQuery().toResourceUri())
  }

  @Test
  fun `preserves form query encoding`() {
    assertEquals(
      "automobile:test-timings?testClass=Example+Test&isCi=true",
      TestTimingQuery(testClass = "Example Test", isCi = true).toResourceUri(),
    )
  }

  @Test
  fun `scopes test runs to a device`() {
    assertEquals(
      "automobile:test-runs?limit=100&deviceId=emulator-5554",
      TestRunQuery(limit = 100, deviceId = "emulator-5554").toResourceUri(),
    )
  }
}
