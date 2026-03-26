package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Provides AI recovery configuration values. */
interface RecoveryConfigProvider {
  /** Whether the ai-recovery feature flag is enabled. */
  fun isRecoveryEnabled(): Boolean

  /** Maximum number of tool calls the Koog agent may use during a single recovery attempt. */
  fun getMaxRecoveryToolCalls(): Int
}

/**
 * Reads recovery config from the daemon's feature-flag resource.
 *
 * The value is cached for the lifetime of the JVM so we only incur one daemon round-trip.
 */
class DaemonRecoveryConfigProvider : RecoveryConfigProvider {

  private data class CachedConfig(val enabled: Boolean, val maxToolCalls: Int)

  @Volatile private var cached: CachedConfig? = null

  override fun isRecoveryEnabled(): Boolean = getConfig().enabled

  override fun getMaxRecoveryToolCalls(): Int = getConfig().maxToolCalls

  private fun getConfig(): CachedConfig {
    cached?.let { return it }

    val config =
        try {
          val response =
              DaemonSocketClientManager.readResource(
                  "automobile:config/feature-flags/ai-recovery",
                  5000L,
              )
          if (!response.success || response.result == null) {
            CachedConfig(DEFAULT_ENABLED, DEFAULT_MAX_TOOL_CALLS)
          } else {
            parseConfig(response)
          }
        } catch (e: Exception) {
          println("Warning: Failed to read ai-recovery config from daemon: ${e.message}")
          CachedConfig(DEFAULT_ENABLED, DEFAULT_MAX_TOOL_CALLS)
        }

    cached = config
    return config
  }

  private fun parseConfig(response: DaemonResponse): CachedConfig {
    val json = Json { ignoreUnknownKeys = true }
    val resultObj = response.result?.jsonObject
        ?: return CachedConfig(DEFAULT_ENABLED, DEFAULT_MAX_TOOL_CALLS)
    val contents = resultObj["contents"]
        ?: return CachedConfig(DEFAULT_ENABLED, DEFAULT_MAX_TOOL_CALLS)
    val firstContent = contents as? kotlinx.serialization.json.JsonArray
        ?: return CachedConfig(DEFAULT_ENABLED, DEFAULT_MAX_TOOL_CALLS)
    if (firstContent.isEmpty()) return CachedConfig(DEFAULT_ENABLED, DEFAULT_MAX_TOOL_CALLS)
    val text = firstContent[0].jsonObject["text"]?.jsonPrimitive?.content
        ?: return CachedConfig(DEFAULT_ENABLED, DEFAULT_MAX_TOOL_CALLS)

    val body = json.parseToJsonElement(text).jsonObject
    val enabled = body["enabled"]?.jsonPrimitive?.content?.toBooleanStrictOrNull()
        ?: DEFAULT_ENABLED
    val configObj = body["config"]?.jsonObject
    val maxToolCalls = configObj?.get("maxToolCalls")?.jsonPrimitive?.int
        ?: DEFAULT_MAX_TOOL_CALLS
    return CachedConfig(enabled, maxToolCalls)
  }

  companion object {
    internal const val DEFAULT_ENABLED = true
    internal const val DEFAULT_MAX_TOOL_CALLS = 5
  }
}

/** Fixed config for use in tests. */
class StaticRecoveryConfigProvider(
    private val enabled: Boolean = true,
    private val maxToolCalls: Int = 5,
) : RecoveryConfigProvider {
  override fun isRecoveryEnabled(): Boolean = enabled
  override fun getMaxRecoveryToolCalls(): Int = maxToolCalls
}
