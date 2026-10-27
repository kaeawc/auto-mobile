package dev.jasonpearson.automobile.junit

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object TestTimingRequest {
  private const val TEST_TIMING_RESOURCE_URI = "automobile:test-timings"
  private const val DEFAULT_LOOKBACK_DAYS = 90
  private const val DEFAULT_LIMIT = 1000
  private const val DEFAULT_MIN_SAMPLES = 1
  private const val DEFAULT_TIMEOUT_MS = 5000L

  fun buildRequestUri(): String {
    val params = mutableListOf<Pair<String, String>>()
    fun addParam(key: String, value: String) {
      params.add(key to value)
    }

    addParam(
      "lookbackDays",
      resolvePositiveIntProperty("automobile.junit.timing.lookback.days", DEFAULT_LOOKBACK_DAYS)
        .toString(),
    )
    addParam(
      "limit",
      resolvePositiveIntProperty("automobile.junit.timing.limit", DEFAULT_LIMIT).toString(),
    )
    addParam("minSamples", resolveMinSamples().toString())
    addParam("devicePlatform", "android")
    // No `sessionUuid`: it is a filter on the session that RECORDED a row. This JVM's client UUID
    // is fresh, and every executePlan attempt records under its own UUID, so scoping the query to
    // either can never match earlier runs and timing history would always load empty (#10091).

    if (params.isEmpty()) {
      return TEST_TIMING_RESOURCE_URI
    }

    val query = params.joinToString("&") { (key, value) -> "$key=${encodeQueryParam(value)}" }
    return "$TEST_TIMING_RESOURCE_URI?$query"
  }

  private fun resolveMinSamples(): Int {
    val value =
      SystemPropertyCache.get(
          "automobile.junit.timing.min.samples",
          DEFAULT_MIN_SAMPLES.toString(),
        )
        .toIntOrNull()
    return when {
      value == null -> DEFAULT_MIN_SAMPLES
      value < 0 -> 0
      else -> value
    }
  }

  private fun resolvePositiveIntProperty(name: String, fallback: Int): Int {
    val value = SystemPropertyCache.get(name, fallback.toString()).toIntOrNull()
    return if (value != null && value > 0) value else fallback
  }

  fun resolveTimeoutMs(): Long {
    val value =
      SystemPropertyCache.get(
          "automobile.junit.timing.fetch.timeout.ms",
          DEFAULT_TIMEOUT_MS.toString(),
        )
        .toLongOrNull()
    return if (value != null && value > 0) value else DEFAULT_TIMEOUT_MS
  }

  fun extractResourcePayload(response: DaemonResponse): String? {
    if (!response.success) {
      return null
    }

    val resultElement = response.result ?: return null
    val resultObject = resultElement.jsonObject
    val contentElement = resultObject["contents"]
    if (contentElement !is JsonArray || contentElement.isEmpty()) {
      return null
    }
    val first = contentElement.first().jsonObject
    return first["text"]?.jsonPrimitive?.content
  }

  private fun encodeQueryParam(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}
