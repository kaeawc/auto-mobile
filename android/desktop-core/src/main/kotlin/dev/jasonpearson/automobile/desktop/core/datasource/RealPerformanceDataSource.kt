package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.performance.PerformanceRun

/**
 * Real performance data source that fetches from MCP resources. Uses the performance-results
 * resource to get actual performance audit data.
 *
 * When [deviceId] is set, the audit-history read is scoped to that device so a pane in a
 * multi-device workspace only surfaces its own device's audit history (the performance-results
 * resource filters server-side by `deviceId`). Null = unscoped (all devices).
 */
class RealPerformanceDataSource(
  private val clientProvider: (() -> AutoMobileClient)? = null,
  private val deviceId: String? = null,
) : PerformanceDataSource {
  override suspend fun getPerformanceRun(): Result<PerformanceRun> {
    val provider = clientProvider ?: return Result.Success(createEmptyRun())

    return try {
      val client = provider()
      val auditResult = client.listPerformanceAuditResults(limit = 50, deviceId = deviceId)

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
}
