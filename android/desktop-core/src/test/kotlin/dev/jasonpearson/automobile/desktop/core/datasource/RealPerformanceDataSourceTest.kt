package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
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

  private fun entry(
    id: Long,
    deviceId: String,
    touchLatencyMs: Double,
    deviceSessionUuid: String? = null,
  ) =
    PerformanceAuditHistoryEntry(
      id = id,
      deviceId = deviceId,
      sessionId = "session-$id",
      packageName = "com.example.app",
      timestamp = "2026-01-01T00:00:0${id}Z",
      passed = true,
      metrics = PerformanceAuditMetrics(touchLatencyMs = touchLatencyMs),
      deviceSessionUuid = deviceSessionUuid,
    )

  private fun clientWithTwoDevices(): FakeAutoMobileClient {
    return FakeAutoMobileClient().apply {
      listPerformanceAuditResultsResult =
        PerformanceAuditHistoryResult(
          results =
            listOf(
              entry(id = 1, deviceId = "device-A", touchLatencyMs = 50.0),
              entry(id = 2, deviceId = "device-B", touchLatencyMs = 999.0),
            ),
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

  /** One serial across two boots, plus an audit recorded before daemons stamped the epoch. */
  private fun clientWithTwoEpochs(): FakeAutoMobileClient {
    return FakeAutoMobileClient().apply {
      listPerformanceAuditResultsResult =
        PerformanceAuditHistoryResult(
          results =
            listOf(
              entry(1, "emulator-5554", touchLatencyMs = 11.0, deviceSessionUuid = "epoch-1"),
              entry(2, "emulator-5554", touchLatencyMs = 22.0, deviceSessionUuid = "epoch-2"),
              entry(3, "emulator-5554", touchLatencyMs = 33.0),
            ),
        )
    }
  }

  private suspend fun touchLatencies(source: RealPerformanceDataSource): List<Float> {
    val result = source.getPerformanceRun()
    assertTrue("expected success, got $result", result is Result.Success)
    val metric = (result as Result.Success).data.metrics.first { it.id == "touch_latency" }
    return metric.history.map { it.value }
  }

  @Test
  fun `each epoch of a reused serial shows only its own audit history`() = runBlocking {
    val client = clientWithTwoEpochs()
    fun source(epoch: String) =
      RealPerformanceDataSource({ client }, deviceId = "emulator-5554", deviceSessionUuid = epoch)

    assertEquals(listOf(11f), touchLatencies(source("epoch-1")))
    assertEquals(listOf(22f), touchLatencies(source("epoch-2")))
    assertEquals("epoch-2", client.lastListPerformanceAuditResultsDeviceSessionUuid)
  }

  @Test
  fun `a daemon that predates the epoch filter still returns device-scoped history`() =
    runBlocking {
      val client =
        clientWithTwoEpochs().apply { performanceResultsSupportsDeviceSessionUuid = false }
      val source =
        RealPerformanceDataSource(
          { client },
          deviceId = "emulator-5554",
          deviceSessionUuid = "epoch-2",
        )

      assertEquals(listOf(11f, 22f, 33f), touchLatencies(source).sorted())
      assertEquals("emulator-5554", client.lastListPerformanceAuditResultsDeviceId)
      assertEquals(null, client.lastListPerformanceAuditResultsDeviceSessionUuid)
    }

  @Test
  fun `other daemon errors are not retried without the epoch filter`() = runBlocking {
    val calls = mutableListOf<String?>()
    val client =
      object : AutoMobileClient by FakeAutoMobileClient() {
        override fun listPerformanceAuditResults(
          startTime: String?,
          endTime: String?,
          limit: Int?,
          offset: Int?,
          deviceId: String?,
          deviceSessionUuid: String?,
        ): PerformanceAuditHistoryResult {
          calls += deviceSessionUuid
          throw McpConnectionException("Failed to retrieve performance audit results: boom")
        }
      }
    val source =
      RealPerformanceDataSource({ client }, deviceId = "emulator-5554", deviceSessionUuid = "e1")

    assertTrue(source.getPerformanceRun() is Result.Error)
    assertEquals(listOf<String?>("e1"), calls)
  }
}
