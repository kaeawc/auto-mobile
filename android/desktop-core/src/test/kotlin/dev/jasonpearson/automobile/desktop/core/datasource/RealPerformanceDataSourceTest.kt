package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditHistoryEntry
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditHistoryResult
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditMetrics
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies that [RealPerformanceDataSource] scopes the audit-history read to its device so a pane
 * in a multi-device workspace only surfaces its own device's audit history (issue #5086).
 */
class RealPerformanceDataSourceTest {

  private fun entry(id: Long, deviceId: String, touchLatencyMs: Double) =
    PerformanceAuditHistoryEntry(
      id = id,
      deviceId = deviceId,
      sessionId = "session-$id",
      packageName = "com.example.app",
      timestamp = "2026-01-01T00:00:0${id}Z",
      passed = true,
      metrics = PerformanceAuditMetrics(touchLatencyMs = touchLatencyMs),
    )

  private fun clientWithTwoDevices(): FakeAutoMobileClient {
    return FakeAutoMobileClient().apply {
      listPerformanceAuditResultsResult =
        PerformanceAuditHistoryResult(
          results =
            listOf(
              entry(id = 1, deviceId = "device-A", touchLatencyMs = 50.0),
              entry(id = 2, deviceId = "device-B", touchLatencyMs = 999.0),
            )
        )
    }
  }

  @Test
  fun `scoped data source threads its deviceId to the client`() = runBlocking {
    val client = clientWithTwoDevices()
    val dataSource = RealPerformanceDataSource(clientProvider = { client }, deviceId = "device-A")

    dataSource.getPerformanceRun()

    assertEquals("device-A", client.lastListPerformanceAuditResultsDeviceId)
  }

  @Test
  fun `pane scoped to device A does not surface device B audit results`() = runBlocking {
    val client = clientWithTwoDevices()
    val dataSource = RealPerformanceDataSource(clientProvider = { client }, deviceId = "device-A")

    val result = dataSource.getPerformanceRun()

    assertTrue(result is Result.Success)
    val run = (result as Result.Success).data
    assertEquals("device-A", run.deviceName)
    val touchLatency = run.metrics.firstOrNull { it.id == "touch_latency" }
    assertTrue("expected a touch_latency metric for device A", touchLatency != null)
    val values = touchLatency!!.history.map { it.value }
    // Device B's distinctive 999ms sample must never leak into device A's pane.
    assertFalse("device B's audit sample leaked into device A", values.contains(999f))
    assertTrue(values.contains(50f))
  }

  @Test
  fun `unscoped data source aggregates all devices`() = runBlocking {
    val client = clientWithTwoDevices()
    val dataSource = RealPerformanceDataSource(clientProvider = { client }, deviceId = null)

    val result = dataSource.getPerformanceRun()

    assertTrue(result is Result.Success)
    val run = (result as Result.Success).data
    val touchLatency = run.metrics.first { it.id == "touch_latency" }
    val values = touchLatency.history.map { it.value }
    assertTrue(values.contains(50f))
    assertTrue(values.contains(999f))
    assertEquals(null, client.lastListPerformanceAuditResultsDeviceId)
  }
}
