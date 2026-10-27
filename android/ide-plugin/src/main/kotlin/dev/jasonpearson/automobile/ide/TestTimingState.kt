package dev.jasonpearson.automobile.ide

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingEntry
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingQuery
import dev.jasonpearson.automobile.desktop.core.daemon.TestTimingSummary
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException

internal class TestTimingState {
  var summary by mutableStateOf<TestTimingSummary?>(null)
  var timings by mutableStateOf<List<TestTimingEntry>>(emptyList())
  var status by mutableStateOf("Idle")
  var error by mutableStateOf<String?>(null)
  val lookbackDaysText = TextFieldState(DEFAULT_LOOKBACK_DAYS.toString())
  val minSamplesText = TextFieldState(DEFAULT_MIN_SAMPLES.toString())
  val limitText = TextFieldState(DEFAULT_LIMIT.toString())
  val filterText = TextFieldState("")
  var sortKey by mutableStateOf(TestTimingSortKey.AVG_DURATION)
  var sortDirection by mutableStateOf(TestTimingSortDirection.DESC)
  var selectedEntry by mutableStateOf<TestTimingEntry?>(null)
  var autoPollEnabled by mutableStateOf(true)
  val pollIntervalMs = 5000L

  fun parseOptionalInt(label: String, value: String, minValue: Int): Int? {
    val trimmed = value.trim()
    if (trimmed.isEmpty()) {
      return null
    }
    val parsed = trimmed.toIntOrNull()
    if (parsed == null) {
      error = "$label must be a number."
      return null
    }
    if (parsed < minValue) {
      error = "$label must be >= $minValue."
      return null
    }
    return parsed
  }

  suspend fun refreshTestTimings(
    client: AutoMobileClient,
    isConnected: Boolean,
    ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  ) {
    if (!isConnected) {
      status = "Not connected"
      return
    }

    error = null
    val lookbackDays =
      parseOptionalInt("Lookback days", lookbackDaysText.text.toString(), minValue = 1)
    val minSamples = parseOptionalInt("Min samples", minSamplesText.text.toString(), minValue = 0)
    val limit = parseOptionalInt("Limit", limitText.text.toString(), minValue = 1)
    if (error != null) {
      status = "Invalid input"
      return
    }

    status = "Refreshing..."
    try {
      val query =
        TestTimingQuery(
          lookbackDays = lookbackDays,
          minSamples = minSamples,
          limit = limit,
          orderBy = sortKey.toOrderByOrNull(),
          orderDirection = sortDirection.toOrderDirection(),
        )
      val response = withContext(ioDispatcher) { client.getTestTimings(query) }
      summary = response
      timings = response.testTimings
      status = "Updated ${response.testTimings.size} test(s)"
    } catch (e: McpConnectionException) {
      reportFailure(e)
    } catch (e: IOException) {
      reportFailure(e)
    } catch (e: SerializationException) {
      reportFailure(e)
    }
  }

  private fun reportFailure(error: Throwable) {
    LoggerFactory.getLogger("TestTimingPanel").warn("Test timing data unavailable", error)
    status = "Test timing data unavailable"
    this.error = error.message
  }
}
