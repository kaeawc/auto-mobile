package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Provides AI recovery configuration values. */
interface RecoveryConfigProvider {
  /** Maximum number of tool calls the Koog agent may use during a single recovery attempt. */
  fun getMaxRecoveryToolCalls(): Int
}

/**
 * Reads recovery config from the daemon's feature-flag resource.
 *
 * The value is cached for the lifetime of the JVM so we only incur one daemon round-trip.
 */
class DaemonRecoveryConfigProvider : RecoveryConfigProvider {

  @Volatile private var cached: Int? = null

  override fun getMaxRecoveryToolCalls(): Int {
    cached?.let { return it }

    val value =
        try {
          val response =
              DaemonSocketClientManager.readResource(
                  "automobile:config/feature-flags/ai-recovery",
                  5000L,
              )
          if (!response.success || response.result == null) {
            DEFAULT_MAX_TOOL_CALLS
          } else {
            parseMaxToolCalls(response)
          }
        } catch (e: Exception) {
          println("Warning: Failed to read ai-recovery config from daemon: ${e.message}")
          DEFAULT_MAX_TOOL_CALLS
        }

    cached = value
    return value
  }

  private fun parseMaxToolCalls(response: DaemonResponse): Int {
    val json = Json { ignoreUnknownKeys = true }
    // Resource response has result.contents[0].text with the JSON body
    val resultObj = response.result?.jsonObject ?: return DEFAULT_MAX_TOOL_CALLS
    val contents = resultObj["contents"] ?: return DEFAULT_MAX_TOOL_CALLS
    val firstContent =
        contents as? kotlinx.serialization.json.JsonArray
            ?: return DEFAULT_MAX_TOOL_CALLS
    if (firstContent.isEmpty()) return DEFAULT_MAX_TOOL_CALLS
    val text = firstContent[0].jsonObject["text"]?.jsonPrimitive?.content
        ?: return DEFAULT_MAX_TOOL_CALLS

    val body = json.parseToJsonElement(text).jsonObject
    val config = body["config"]?.jsonObject ?: return DEFAULT_MAX_TOOL_CALLS
    return config["maxToolCalls"]?.jsonPrimitive?.int ?: DEFAULT_MAX_TOOL_CALLS
  }

  companion object {
    internal const val DEFAULT_MAX_TOOL_CALLS = 5
  }
}

/** Fixed config for use in tests. */
class StaticRecoveryConfigProvider(private val maxToolCalls: Int = 5) : RecoveryConfigProvider {
  override fun getMaxRecoveryToolCalls(): Int = maxToolCalls
}
