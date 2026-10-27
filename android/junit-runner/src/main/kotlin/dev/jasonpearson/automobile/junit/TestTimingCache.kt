package dev.jasonpearson.automobile.junit

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

@Serializable
internal data class TestTimingStatusCounts(
  val passed: Int = 0,
  val failed: Int = 0,
  val skipped: Int = 0,
)

@Serializable
internal data class TestTimingEntry(
  val testClass: String,
  val testMethod: String,
  val averageDurationMs: Int = 0,
  val sampleSize: Int = 0,
  val lastRun: String? = null,
  val lastRunTimestampMs: Long? = null,
  val successRate: Double? = null,
  val failureRate: Double? = null,
  val stdDevDurationMs: Int? = null,
  val statusCounts: TestTimingStatusCounts? = null,
)

@Serializable
internal data class TestTimingSummary(
  val testTimings: List<TestTimingEntry> = emptyList(),
  val generatedAt: String? = null,
  val totalTests: Int = 0,
  val totalSamples: Int = 0,
)

internal data class TestTimingKey(val testClass: String, val testMethod: String)

internal interface TestTimingSource {
  fun hasTimings(): Boolean

  fun getTiming(
    testClass: String,
    testMethod: String,
    legacySimpleName: String? = null,
  ): TestTimingEntry?
}

internal object TestTimingCache : TestTimingSource {
  private val store = TestTimingStore()

  fun prefetchIfEnabled() = store.prefetchIfEnabled()

  override fun getTiming(
    testClass: String,
    testMethod: String,
    legacySimpleName: String?,
  ): TestTimingEntry? = store.getTiming(testClass, testMethod, legacySimpleName)

  override fun hasTimings(): Boolean = store.hasTimings()

  fun getSummary(): TestTimingSummary? = store.getSummary()

  fun clear() = store.clear()
}

internal class TestTimingStore(
  private val ciMode: () -> Boolean = ::isCiMode,
  private val collaborators: PlanExecutorCollaborators = PlanExecutorCollaborators(),
) : TestTimingSource {
  private companion object {
    fun isCiMode(): Boolean {
      if (SystemPropertyCache.getBoolean("automobile.ci.mode", false)) {
        return true
      }
      val envValue = System.getenv("CI") ?: return false
      return envValue.equals("true", ignoreCase = true) || envValue == "1"
    }
  }

  private val json = Json { ignoreUnknownKeys = true }
  private val loaded = AtomicBoolean(false)
  private val loadLock = Any()

  @Volatile private var timingMap: Map<TestTimingKey, TestTimingEntry> = emptyMap()
  @Volatile private var summary: TestTimingSummary? = null

  fun prefetchIfEnabled() {
    if (!isEnabled()) {
      return
    }

    if (loaded.get()) {
      return
    }

    synchronized(loadLock) {
      if (loaded.get()) {
        return
      }
      loadFromDaemon()
      loaded.set(true)
    }
  }

  /**
   * Timing for [testClass] (fully qualified, as recorded since #10091). Rows recorded before that
   * change were keyed by simple name, so [legacySimpleName] is consulted only when no
   * fully-qualified row exists, keeping that history until it ages out of the lookback window.
   */
  override fun getTiming(
    testClass: String,
    testMethod: String,
    legacySimpleName: String?,
  ): TestTimingEntry? {
    prefetchIfEnabled()
    return timingMap[TestTimingKey(testClass, testMethod)]
      ?: legacySimpleName
        ?.takeIf { it != testClass }
        ?.let { timingMap[TestTimingKey(it, testMethod)] }
  }

  override fun hasTimings(): Boolean {
    prefetchIfEnabled()
    return timingMap.isNotEmpty()
  }

  fun getSummary(): TestTimingSummary? {
    prefetchIfEnabled()
    return summary
  }

  fun clear() {
    timingMap = emptyMap()
    summary = null
    loaded.set(false)
  }

  private fun isEnabled(): Boolean {
    if (ciMode()) {
      return false
    }
    // Skip timing fetch if no devices are available - tests will be skipped anyway
    if (!collaborators.deviceChecker.areDevicesAvailable()) {
      return false
    }
    return SystemPropertyCache.getBoolean("automobile.junit.timing.enabled", true)
  }

  private fun loadFromDaemon() {
    try {
      val uri = TestTimingRequest.buildRequestUri()
      val response = collaborators.daemon.readResource(uri, TestTimingRequest.resolveTimeoutMs())
      val payload = TestTimingRequest.extractResourcePayload(response)
      if (payload.isNullOrBlank()) {
        return
      }

      val element = json.decodeFromString(serializer<JsonElement>(), payload)
      val error = (element as? JsonObject)?.get("error")?.jsonPrimitive?.content
      if (!error.isNullOrBlank()) {
        return
      }

      val parsed = json.decodeFromJsonElement(serializer<TestTimingSummary>(), element)
      summary = parsed
      timingMap = parsed.testTimings.associateBy { TestTimingKey(it.testClass, it.testMethod) }
    } catch (e: Exception) {
      println("Warning: Test timing fetch failed: $e")
    }
  }
}
