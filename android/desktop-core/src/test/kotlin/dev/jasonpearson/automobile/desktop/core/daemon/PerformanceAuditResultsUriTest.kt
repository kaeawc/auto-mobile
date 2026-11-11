package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals

class PerformanceAuditResultsUriTest {

  @Test
  fun `omits absent parameters`() {
    assertEquals("automobile:performance-results", PerformanceAuditQuery().toResourceUri())
  }

  @Test
  fun `scopes audit-history read to a device`() {
    assertEquals(
      "automobile:performance-results?limit=50&deviceId=emulator-5554",
      PerformanceAuditQuery(limit = 50, deviceId = "emulator-5554").toResourceUri(),
    )
  }

  @Test
  fun `scopes audit-history read to a device epoch`() {
    assertEquals(
      "automobile:performance-results?deviceId=emulator-5554&deviceSessionUuid=epoch-1",
      PerformanceAuditQuery(deviceId = "emulator-5554", deviceSessionUuid = "epoch-1")
        .toResourceUri(),
    )
  }
}
