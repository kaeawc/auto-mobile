package dev.jasonpearson.automobile.desktop.core.failures

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.McpResourceContent
import dev.jasonpearson.automobile.desktop.core.daemon.decodeResourceResponse
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.time.Clock
import dev.jasonpearson.automobile.desktop.core.time.SystemClock
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer

typealias TimelineData = dev.jasonpearson.automobile.desktop.domain.TimelineData

typealias TimelineDataPoint = dev.jasonpearson.automobile.desktop.domain.TimelineDataPoint

typealias PeriodTotals = dev.jasonpearson.automobile.desktop.domain.PeriodTotals

typealias DateRange = dev.jasonpearson.automobile.desktop.domain.DateRange

typealias TimeAggregation = dev.jasonpearson.automobile.desktop.domain.TimeAggregation

// DataSourceMode has been moved to dev.jasonpearson.automobile.desktop.core.datasource package

/** Interface for accessing failures data */
interface FailuresDataSource {
  suspend fun getFailureGroups(): Result<List<FailureGroup>>

  suspend fun getTimelineData(
    dateRange: DateRange,
    aggregation: TimeAggregation,
  ): Result<TimelineData>
}

/** Mock data source that uses local mock data */
class MockFailuresDataSource(private val clock: Clock = SystemClock) : FailuresDataSource {
  override suspend fun getFailureGroups(): Result<List<FailureGroup>> {
    return Result.Success(createMockFailureGroups(clock))
  }

  override suspend fun getTimelineData(
    dateRange: DateRange,
    aggregation: TimeAggregation,
  ): Result<TimelineData> {
    return Result.Success(
      TimelineData(
        dataPoints = generateMockTimelineData(dateRange, aggregation, clock),
        previousPeriodTotals = generateMockPreviousPeriodTotals(dateRange),
      ),
    )
  }
}

/** Empty data source that returns empty results (for Real mode when MCP not available) */
class EmptyFailuresDataSource : FailuresDataSource {
  override suspend fun getFailureGroups(): Result<List<FailureGroup>> {
    return Result.Success(emptyList())
  }

  override suspend fun getTimelineData(
    dateRange: DateRange,
    aggregation: TimeAggregation,
  ): Result<TimelineData> {
    return Result.Success(
      TimelineData(
        dataPoints = emptyList(),
        previousPeriodTotals = PeriodTotals(0, 0, 0),
      ),
    )
  }
}

/**
 * MCP data source that reads from the MCP server.
 *
 * [AutoMobileClient.readResource] is a blocking socket round trip with no deadline of its own, and
 * these suspend functions are called from the Compose UI thread. Each read therefore runs on
 * [ioDispatcher] via [runInterruptible] (cancellation, e.g. the dashboard leaving composition,
 * interrupts the blocked read) and under a [readTimeoutMs] ceiling so a stalled daemon cannot pin
 * an IO thread forever (#10142).
 */
class McpFailuresDataSource(
  private val clientProvider: () -> AutoMobileClient,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  private val readTimeoutMs: Long = DEFAULT_READ_RESOURCE_TIMEOUT_MS,
) : FailuresDataSource {
  private val json = Json { ignoreUnknownKeys = true }

  override suspend fun getFailureGroups(): Result<List<FailureGroup>> {
    return try {
      val response =
        readOffMainThread("automobile:failures") { contents ->
          decodeResourceResponse(json, contents, serializer<FailuresResponse>())
        }
      Result.Success(response.groups.map { it.toModel() })
    } catch (e: McpConnectionException) {
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: CancellationException) {
      throw e
    } catch (e: IOException) {
      Result.Error(e, "Failed to load failures: ${e.message}")
    } catch (e: IllegalArgumentException) {
      Result.Error(e, "Failed to load failures: ${e.message}")
    }
  }

  override suspend fun getTimelineData(
    dateRange: DateRange,
    aggregation: TimeAggregation,
  ): Result<TimelineData> {
    return try {
      val uri =
        "automobile:failures/timeline?dateRange=${dateRange.toQueryParam()}&aggregation=${aggregation.toQueryParam()}"
      val response =
        readOffMainThread(uri) { contents ->
          decodeResourceResponse(json, contents, serializer<TimelineResponse>())
        }
      Result.Success(
        TimelineData(
          dataPoints =
            response.dataPoints.map {
              TimelineDataPoint(it.label, it.crashes, it.anrs, it.toolFailures, it.nonfatals)
            },
          previousPeriodTotals =
            PeriodTotals(
              response.previousPeriodTotals.crashes,
              response.previousPeriodTotals.anrs,
              response.previousPeriodTotals.toolFailures,
              response.previousPeriodTotals.nonfatals,
            ),
        ),
      )
    } catch (e: McpConnectionException) {
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: CancellationException) {
      throw e
    } catch (e: IOException) {
      Result.Error(e, "Failed to load timeline: ${e.message}")
    } catch (e: IllegalArgumentException) {
      Result.Error(e, "Failed to load timeline: ${e.message}")
    }
  }

  /**
   * Blocking read plus decode on [ioDispatcher]. The timeout wraps the context switch, so it runs
   * on the caller's clock; on expiry the interrupt unblocks the read and the call fails with a
   * typed [McpConnectionException] instead of hanging.
   */
  private suspend fun <T> readOffMainThread(
    uri: String,
    decode: (List<McpResourceContent>) -> T,
  ): T {
    // Resolve the client on the caller's thread: the provider may read UI-owned state.
    val client = clientProvider()
    return withTimeoutOrNull(readTimeoutMs) {
      runInterruptible(ioDispatcher) { decode(client.readResource(uri)) }
    } ?: throw McpConnectionException("Timed out after ${readTimeoutMs}ms reading $uri")
  }

  companion object {
    /** Matches the daemon's default request deadline and the failures stream socket watchdog. */
    const val DEFAULT_READ_RESOURCE_TIMEOUT_MS = 30_000L
  }
}

// Serializable response models for MCP resources

@Serializable
private data class FailuresResponse(
  val groups: List<FailureGroupDto>,
  val generatedAt: String,
)

@Serializable
private data class FailureGroupDto(
  val id: String,
  val type: String,
  val signature: String,
  val title: String,
  val message: String,
  val firstOccurrence: Long,
  val lastOccurrence: Long,
  val totalCount: Int,
  val uniqueSessions: Int,
  val severity: String,
  val deviceBreakdown: List<DeviceBreakdownDto>,
  val versionBreakdown: List<VersionBreakdownDto>,
  val screenBreakdown: List<ScreenBreakdownDto>,
  val failureScreens: Map<String, Int>,
  val stackTraceElements: List<StackTraceElementDto>,
  val toolCallInfo: AggregatedToolCallInfoDto? = null,
  val affectedTests: Map<String, Int>,
  val recentCaptures: List<FailureCaptureDto>,
  val sampleOccurrences: List<FailureOccurrenceDto>,
) {
  fun toModel(): FailureGroup =
    FailureGroup(
      id = id,
      type = failureTypeOf(type),
      signature = signature,
      title = title,
      message = message,
      firstOccurrence = firstOccurrence,
      lastOccurrence = lastOccurrence,
      totalCount = totalCount,
      uniqueSessions = uniqueSessions,
      severity = failureSeverityOf(severity),
      deviceBreakdown =
        deviceBreakdown.map {
          DeviceBreakdown(it.deviceModel, it.os, it.count, it.percentage)
        },
      versionBreakdown =
        versionBreakdown.map {
          VersionBreakdown(it.version, it.count, it.percentage)
        },
      screenBreakdown =
        screenBreakdown.map {
          ScreenBreakdown(it.screenName, it.visitCount, it.failureCount, it.visitPercentage)
        },
      failureScreens = failureScreens,
      stackTraceElements =
        stackTraceElements.map {
          StackTraceElement(
            it.className,
            it.methodName,
            it.fileName,
            it.lineNumber,
            it.isAppCode,
          )
        },
      toolCallInfo = toolCallInfo?.toModel(),
      affectedTests = affectedTests,
      recentCaptures =
        recentCaptures.map {
          FailureCapture(
            it.id,
            if (it.type == "video") CaptureType.Video else CaptureType.Screenshot,
            it.path,
            it.timestamp,
            it.deviceModel,
          )
        },
      sampleOccurrences = sampleOccurrences.map { it.toModel() },
    )
}

@Serializable
private data class DeviceBreakdownDto(
  val deviceModel: String,
  val os: String,
  val count: Int,
  val percentage: Float,
)

@Serializable
private data class VersionBreakdownDto(
  val version: String,
  val count: Int,
  val percentage: Float,
)

@Serializable
private data class ScreenBreakdownDto(
  val screenName: String,
  val visitCount: Int,
  val failureCount: Int,
  val visitPercentage: Float,
)

@Serializable
private data class StackTraceElementDto(
  val className: String,
  val methodName: String,
  val fileName: String? = null,
  val lineNumber: Int? = null,
  val isAppCode: Boolean = false,
)

@Serializable
private data class AggregatedToolCallInfoDto(
  val toolName: String,
  val errorCodes: Map<String, Int>,
  val parameterVariants: Map<String, List<String>>,
  val durationStats: DurationStatsDto? = null,
)

@Serializable
private data class DurationStatsDto(
  val minMs: Long,
  val maxMs: Long,
  val avgMs: Long,
  val medianMs: Long,
  val p95Ms: Long,
)

@Serializable
private data class FailureCaptureDto(
  val id: String,
  val type: String,
  val path: String,
  val timestamp: Long,
  val deviceModel: String,
)

@Serializable
private data class FailureOccurrenceDto(
  val id: String,
  val timestamp: Long,
  val deviceModel: String,
  val os: String,
  val appVersion: String,
  val sessionId: String,
  val screenAtFailure: String? = null,
  val screensVisited: List<String>,
  val testName: String? = null,
  val capturePath: String? = null,
  val captureType: String? = null,
)

@Serializable
private data class TimelineResponse(
  val dataPoints: List<TimelineDataPointDto>,
  val dateRange: String,
  val aggregation: String,
  val previousPeriodTotals: PeriodTotalsDto,
)

@Serializable
private data class TimelineDataPointDto(
  val label: String,
  val crashes: Int,
  val anrs: Int,
  val toolFailures: Int,
  val nonfatals: Int = 0,
)

@Serializable
private data class PeriodTotalsDto(
  val crashes: Int,
  val anrs: Int,
  val toolFailures: Int,
  val nonfatals: Int = 0,
)

// Maximum number of buckets we can reasonably display
private const val MAX_DISPLAYABLE_BUCKETS = 100

/** Generate mock timeline data with relative time labels */
internal fun generateMockTimelineData(
  dateRange: DateRange,
  aggregation: TimeAggregation,
  clock: Clock = SystemClock,
): List<TimelineDataPoint> {
  val random = kotlin.random.Random(42) // Fixed seed for consistent data

  // Calculate number of buckets, capped at displayable limit
  val buckets =
    (dateRange.durationMs / aggregation.durationMs).toInt().coerceIn(1, MAX_DISPLAYABLE_BUCKETS)

  return (0 until buckets).map { i ->
    // Calculate time offset from now (bucket 0 is most recent)
    val bucketIndex = buckets - 1 - i // Reverse so oldest first
    val timeAgoMs = bucketIndex * aggregation.durationMs

    // Generate relative time label
    val label = formatRelativeTimeLabel(timeAgoMs, aggregation, clock)

    // Generate realistic-looking failure data with some variance
    val baseCrashes =
      when (aggregation) {
        TimeAggregation.Minute -> random.nextInt(0, 5)
        TimeAggregation.Hour -> random.nextInt(2, 15)
        TimeAggregation.Day -> random.nextInt(10, 50)
        TimeAggregation.Week -> random.nextInt(30, 150)
      }
    val baseAnrs = baseCrashes / 3
    val baseToolFailures = baseCrashes / 2
    val baseNonfatals = baseCrashes * 2 // Non-fatals are typically more common

    TimelineDataPoint(
      label = label,
      crashes = baseCrashes,
      anrs = baseAnrs,
      toolFailures = baseToolFailures,
      nonfatals = baseNonfatals,
    )
  }
}

/** Format a local human-readable time label for the timeline */
private fun formatRelativeTimeLabel(
  timeAgoMs: Long,
  aggregation: TimeAggregation,
  clock: Clock = SystemClock,
): String {
  val now = clock.nowMs()
  val timestamp = now - timeAgoMs
  val calendar = java.util.Calendar.getInstance()
  calendar.timeInMillis = timestamp

  return when (aggregation) {
    TimeAggregation.Minute -> {
      // Show local time like "7:45 PM"
      if (timeAgoMs == 0L) {
        "now"
      } else {
        val hour = calendar.get(java.util.Calendar.HOUR)
        val minute = calendar.get(java.util.Calendar.MINUTE)
        val amPm =
          if (calendar.get(java.util.Calendar.AM_PM) == java.util.Calendar.AM) "AM" else "PM"
        val displayHour = if (hour == 0) 12 else hour
        "${displayHour}:${minute.toString().padStart(2, '0')} $amPm"
      }
    }
    TimeAggregation.Hour -> {
      // Show local hour like "3 PM", "11 AM"
      if (timeAgoMs == 0L) {
        "now"
      } else {
        val hour = calendar.get(java.util.Calendar.HOUR)
        val amPm =
          if (calendar.get(java.util.Calendar.AM_PM) == java.util.Calendar.AM) "AM" else "PM"
        val displayHour = if (hour == 0) 12 else hour
        "$displayHour $amPm"
      }
    }
    TimeAggregation.Day -> {
      // Show actual date like "Jan 18"
      val month =
        calendar.getDisplayName(
          java.util.Calendar.MONTH,
          java.util.Calendar.SHORT,
          java.util.Locale.getDefault(),
        ) ?: ""
      val day = calendar.get(java.util.Calendar.DAY_OF_MONTH)
      "$month $day"
    }
    TimeAggregation.Week -> {
      // Calculate the Monday of the week
      val dayOfWeek = calendar.get(java.util.Calendar.DAY_OF_WEEK)
      val daysToMonday =
        if (dayOfWeek == java.util.Calendar.SUNDAY) -6 else java.util.Calendar.MONDAY - dayOfWeek
      calendar.add(java.util.Calendar.DAY_OF_MONTH, daysToMonday)

      val month =
        calendar.getDisplayName(
          java.util.Calendar.MONTH,
          java.util.Calendar.SHORT,
          java.util.Locale.getDefault(),
        ) ?: ""
      val day = calendar.get(java.util.Calendar.DAY_OF_MONTH)
      "$month $day"
    }
  }
}

/** Generate mock totals for the previous equivalent period */
internal fun generateMockPreviousPeriodTotals(dateRange: DateRange): PeriodTotals {
  // Use a different seed based on date range to get consistent but different values
  val random = kotlin.random.Random(dateRange.ordinal + 100)

  // Generate totals that are somewhat similar to current period but with variance
  val baseCrashes =
    when (dateRange) {
      DateRange.OneHour -> random.nextInt(50, 150)
      DateRange.TwentyFourHours -> random.nextInt(200, 600)
      DateRange.ThreeDays -> random.nextInt(500, 1500)
      DateRange.SevenDays -> random.nextInt(1000, 3000)
      DateRange.ThirtyDays -> random.nextInt(3000, 8000)
    }

  return PeriodTotals(
    crashes = baseCrashes,
    anrs = baseCrashes / 3,
    toolFailures = baseCrashes / 2,
  )
}

/** Create mock failure data for demonstration with aggregated data across multiple occurrences */
internal fun createMockFailureGroups(clock: Clock = SystemClock): List<FailureGroup> {
  val now = clock.nowMs()

  return listOf(
    mockFailureGroup1(now),
    mockFailureGroup2(now),
    mockFailureGroup3(now),
    mockFailureGroup4(now),
  )
}

private fun AggregatedToolCallInfoDto.toModel(): AggregatedToolCallInfo =
  AggregatedToolCallInfo(
    toolName = this.toolName,
    errorCodes = this.errorCodes,
    parameterVariants = this.parameterVariants,
    durationStats =
      this.durationStats?.let { stats ->
        DurationStats(
          stats.minMs,
          stats.maxMs,
          stats.avgMs,
          stats.medianMs,
          stats.p95Ms,
        )
      },
  )

private fun FailureOccurrenceDto.toModel(): FailureOccurrence =
  FailureOccurrence(
    this.id,
    this.timestamp,
    this.deviceModel,
    this.os,
    this.appVersion,
    this.sessionId,
    this.screenAtFailure,
    this.screensVisited,
    this.testName,
    this.capturePath,
    this.captureType?.let { type ->
      if (type == "video") CaptureType.Video else CaptureType.Screenshot
    },
  )

private fun failureTypeOf(value: String): FailureType =
  when (value) {
    "crash" -> FailureType.Crash
    "anr" -> FailureType.ANR
    "tool_failure" -> FailureType.ToolCallFailure
    "nonfatal" -> FailureType.NonFatal
    else -> FailureType.Crash
  }

private fun failureSeverityOf(value: String): FailureSeverity =
  when (value) {
    "critical" -> FailureSeverity.Critical
    "high" -> FailureSeverity.High
    "medium" -> FailureSeverity.Medium
    "low" -> FailureSeverity.Low
    else -> FailureSeverity.Medium
  }
