package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals

class PerformanceAuditResultsUriTest {

  @Test
  fun `omits absent parameters`() {
    assertEquals(
      "automobile:performance-results",
      buildPerformanceResultsUri(
        startTime = null,
        endTime = null,
        limit = null,
        offset = null,
        deviceId = null,
      ),
    )
  }

  @Test
  fun `scopes audit-history read to a device`() {
    assertEquals(
      "automobile:performance-results?limit=50&deviceId=emulator-5554",
      buildPerformanceResultsUri(
        startTime = null,
        endTime = null,
        limit = 50,
        offset = null,
        deviceId = "emulator-5554",
      ),
    )
  }
}
