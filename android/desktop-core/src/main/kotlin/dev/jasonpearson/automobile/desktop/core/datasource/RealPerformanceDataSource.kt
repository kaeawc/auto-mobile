package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditHistoryResult
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceAuditQuery
import dev.jasonpearson.automobile.desktop.core.daemon.isUnknownDeviceSessionUuidFilter
import dev.jasonpearson.automobile.desktop.core.performance.PerformanceRun

/**
 * Real performance data source that fetches from MCP resources. Uses the performance-results
 * resource to get actual performance audit data.
 *
 * When [deviceId] is set, the audit-history read is scoped to that device so a pane in a
 * multi-device workspace only surfaces its own device's audit history (the performance-results
 * resource filters server-side by `deviceId`). Null = unscoped (all devices).
 *
 * When [deviceSessionUuid] is also set, the read is scoped to that device epoch, so a rebooted
 * device that reuses its serial shows only this boot's audits. A daemon that predates the epoch
 * filter rejects it; the read then falls back to device-scoped history.
 */
class RealPerformanceDataSource(
  private val clientProvider: (() -> AutoMobileClient)? = null,
  private val deviceId: String? = null,
  private val deviceSessionUuid: String? = null,
) : PerformanceDataSource {
  override suspend fun getPerformanceRun(): Result<PerformanceRun> {
    val provider = clientProvider ?: return Result.Success(createEmptyRun())

    return try {
      val auditResult = readHistory(provider())

      if (auditResult.results.isEmpty()) {
        return Result.Success(createEmptyRun())
      }

      aggregatePerformance(auditResult)
    } catch (e: McpConnectionException) {
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: IllegalArgumentException) {
      Result.Error(e, "Failed to load performance data: ${e.message}")
    }
  }

  private fun readHistory(client: AutoMobileClient): PerformanceAuditHistoryResult {
    val deviceScoped = PerformanceAuditQuery(limit = HISTORY_LIMIT, deviceId = deviceId)
    if (deviceSessionUuid == null) {
      return client.listPerformanceAuditResults(deviceScoped)
    }
    return try {
      client.listPerformanceAuditResults(deviceScoped.copy(deviceSessionUuid = deviceSessionUuid))
    } catch (e: McpConnectionException) {
      if (!e.isUnknownDeviceSessionUuidFilter()) throw e
      client.listPerformanceAuditResults(deviceScoped)
    }
  }

  private companion object {
    const val HISTORY_LIMIT = 50
  }
}
